import { google, type calendar_v3 } from 'googleapis';
import { clinicDate, clinicInstant, CLINIC_TIMEZONE, formatAppointment } from '@/lib/clinic-time';
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

export async function getAvailableSlots(date: string) {
  const opening = clinicInstant(date, process.env.CLINIC_OPEN_TIME || '09:00');
  const closing = clinicInstant(date, process.env.CLINIC_CLOSE_TIME || '19:00');
  const duration = APPOINTMENT_MINUTES * 60_000;
  if (closing.getTime() <= opening.getTime()) throw new Error('Horario de clínica inválido');
  if (closing.getTime() <= Date.now()) return { date, slots: [] };

  const busy = await getBusySlots(opening.toISOString(), closing.toISOString());
  const slots = [];
  for (let start = opening.getTime(); start + duration <= closing.getTime(); start += 15 * 60_000) {
    const end = start + duration;
    if (start <= Date.now() || busy.some(slot => start < Date.parse(slot.end || '') && end > Date.parse(slot.start || ''))) continue;
    const iso = new Date(start).toISOString();
    slots.push({ start: iso, end: new Date(end).toISOString(), label: formatAppointment(iso) });
  }
  return { date, slots };
}

export async function createCalendarAppointment(params: {
  actionId: string; patientName: string; patientPhone: string; startTime: string; isUrgent?: boolean;
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
      summary: `${params.isUrgent ? '[URGENTE] ' : ''}Cita: ${params.patientName}`,
      start: { dateTime: slot.start, timeZone: CLINIC_TIMEZONE },
      end: { dateTime: slot.end, timeZone: CLINIC_TIMEZONE },
      extendedProperties: { private: { patientPhone: params.patientPhone } },
    },
  }, { timeout: 10_000 });
  if (!event.data.id) throw new Error('Calendar no devolvió el identificador de la cita');
  return slot;
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
