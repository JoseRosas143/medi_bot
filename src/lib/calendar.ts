import { google, type calendar_v3 } from 'googleapis';
import { clinicDate, clinicInstant, CLINIC_TIMEZONE, formatAppointment, nextDate } from '@/lib/clinic-time';
import { isWhatsAppPhone, phoneDigits } from '@/lib/whatsapp';

const APPOINTMENT_MINUTES = 45;

export interface CalendarEventData {
  eventId: string;
  summary: string;
  start: string;
  end: string;
  patientPhone: string;
}

function getCalendarClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!email || !key || !calendarId) throw new Error('Calendar configuration is incomplete');
  const auth = new google.auth.JWT({ email, key, scopes: ['https://www.googleapis.com/auth/calendar'] });
  return { calendar: google.calendar({ version: 'v3', auth }), calendarId };
}

function eventContact(event: calendar_v3.Schema$Event): string {
  const phone = phoneDigits(event.extendedProperties?.private?.patientPhone || undefined);
  return isWhatsAppPhone(phone) ? phone : '';
}

function toAppointment(event: calendar_v3.Schema$Event): CalendarEventData | null {
  const { id, start, end, summary, status } = event;
  if (status === 'cancelled' || !id || !start?.dateTime || !end?.dateTime) return null;
  return { eventId: id, summary: summary || 'Cita', start: start.dateTime, end: end.dateTime, patientPhone: eventContact(event) };
}

async function getBusySlots(start: string, end: string) {
  const { calendar, calendarId } = getCalendarClient();
  const response = await calendar.freebusy.query({
    requestBody: { timeMin: start, timeMax: end, timeZone: CLINIC_TIMEZONE, items: [{ id: calendarId }] },
  }, { timeout: 8_000 });
  const result = response.data.calendars?.[calendarId];
  if (!result || result.errors?.length) throw new Error('No se pudo verificar disponibilidad en Calendar');
  return result.busy || [];
}

function workingHours(date: string) {
  const opening = clinicInstant(date, process.env.CLINIC_OPEN_TIME || '09:00');
  const closing = clinicInstant(date, process.env.CLINIC_CLOSE_TIME || '19:00');
  if (closing.getTime() <= opening.getTime()) throw new Error('Horario de clínica inválido');
  return { opening, closing };
}

function availableSlots(opening: Date, closing: Date, busy: calendar_v3.Schema$TimePeriod[], after: number) {
  const duration = APPOINTMENT_MINUTES * 60_000;
  const slots = [];
  for (let start = opening.getTime(); start + duration <= closing.getTime(); start += 15 * 60_000) {
    const end = start + duration;
    if (start <= after || busy.some(slot => start < Date.parse(slot.end || '') && end > Date.parse(slot.start || ''))) continue;
    const iso = new Date(start).toISOString();
    slots.push({ start: iso, end: new Date(end).toISOString(), label: formatAppointment(iso) });
  }
  return slots;
}

export async function getAvailableSlots(date: string) {
  const { opening, closing } = workingHours(date);
  const now = Date.now();
  if (closing.getTime() <= now) return { date, slots: [] };
  const busy = await getBusySlots(opening.toISOString(), closing.toISOString());
  return { date, slots: availableSlots(opening, closing, busy, now) };
}

export async function getUpcomingSlots(after = Date.now()) {
  const earliest = Math.max(after, Date.now());
  const days = [];
  for (let date = clinicDate(new Date(earliest)), index = 0; index < 14; index++, date = nextDate(date)) {
    days.push(workingHours(date));
  }
  const busy = await getBusySlots(days[0].opening.toISOString(), days[days.length - 1].closing.toISOString());
  return days.flatMap(({ opening, closing }) => availableSlots(opening, closing, busy, earliest));
}

export async function createCalendarAppointment(params: {
  actionId: string; patientName: string; patientPhone: string; startTime: string; reason: string;
}) {
  const { calendar, calendarId } = getCalendarClient();
  const start = new Date(params.startTime);
  if (!Number.isFinite(start.getTime())) throw new Error('Hora inválida');
  const availability = await getAvailableSlots(clinicDate(start));
  const slot = availability.slots.find(item => item.start === start.toISOString());
  if (!slot) return null;
  const event = await calendar.events.insert({
    calendarId,
    requestBody: {
      id: params.actionId.replaceAll('-', ''),
      summary: `Cita: ${params.patientName}`,
      visibility: 'private',
      description: `Motivo o tratamiento indicado por el paciente: ${params.reason}`,
      start: { dateTime: slot.start, timeZone: CLINIC_TIMEZONE },
      end: { dateTime: slot.end, timeZone: CLINIC_TIMEZONE },
      extendedProperties: { private: { patientPhone: params.patientPhone } },
    },
  }, { timeout: 10_000 });
  if (!event.data.id) throw new Error('Calendar no devolvió el identificador de la cita');
  return slot;
}

export async function findCalendarBooking(actionId: string) {
  const { calendar, calendarId } = getCalendarClient();
  try {
    const { data } = await calendar.events.get({ calendarId, eventId: actionId.replaceAll('-', '') }, { timeout: 8_000 });
    return toAppointment(data);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && [404, 410].includes(Number(error.code))) {
      return null;
    }
    throw error;
  }
}

async function listAppointments(options: calendar_v3.Params$Resource$Events$List): Promise<CalendarEventData[]> {
  const { calendar, calendarId } = getCalendarClient();
  const appointments: CalendarEventData[] = [];
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({
      ...options, calendarId, pageToken, maxResults: 250, singleEvents: true,
      showDeleted: false, orderBy: 'startTime', timeZone: CLINIC_TIMEZONE,
    }, { timeout: 8_000 });
    for (const event of response.data.items || []) {
      const appointment = toAppointment(event);
      if (appointment) appointments.push(appointment);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return appointments;
}

export function getAppointmentsByDateRange(startIso: string, endIso: string) {
  return listAppointments({ timeMin: startIso, timeMax: endIso });
}

export async function getPatientAppointments(patientPhone: string) {
  const now = new Date();
  const events = await listAppointments({ timeMin: now.toISOString(), privateExtendedProperty: [`patientPhone=${patientPhone}`] });
  return events.filter(event => event.patientPhone === patientPhone && Date.parse(event.start) > now.getTime());
}

export function appointmentPatientName(summary: string) {
  return summary.replace(/^(\[URGENTE\]\s*)?Cita:\s*/i, '').trim() || 'Paciente';
}

export async function cancelCalendarEvent(expected: CalendarEventData, ownerPhone?: string) {
  const { calendar, calendarId } = getCalendarClient();
  const response = await calendar.events.get({ calendarId, eventId: expected.eventId }, { timeout: 8_000 });
  const current = toAppointment(response.data);
  if (!current || Date.parse(current.start) <= Date.now() ||
      Date.parse(current.start) !== Date.parse(expected.start) || current.summary !== expected.summary ||
      current.patientPhone !== expected.patientPhone || (ownerPhone && current.patientPhone !== ownerPhone)) {
    return null;
  }
  const etag = response.data.etag;
  if (!etag) throw new Error('Calendar no devolvió la versión de la cita');
  await calendar.events.delete({ calendarId, eventId: expected.eventId }, {
    headers: { 'If-Match': etag }, timeout: 10_000,
  });
  return current;
}
