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
  attendanceConfirmed?: boolean;
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
  const confirmedFor = event.extendedProperties?.private?.attendanceConfirmedFor;
  return {
    eventId: id, summary: summary || 'Cita', start: start.dateTime, end: end.dateTime, patientPhone: eventContact(event),
    attendanceConfirmed: Boolean(confirmedFor && Date.parse(confirmedFor) === Date.parse(start.dateTime)),
  };
}

async function getBusySlots(start: string, end: string) {
  const { calendar, calendarId } = getCalendarClient();
  const [response, events] = await Promise.all([
    calendar.freebusy.query({
      requestBody: { timeMin: start, timeMax: end, timeZone: CLINIC_TIMEZONE, items: [{ id: calendarId }] },
    }, { timeout: 8_000 }),
    listCalendarEvents({
      timeMin: start, timeMax: end, eventTypes: ['default'],
      fields: 'nextPageToken,items(start/dateTime,end/dateTime,status,transparency,extendedProperties/private)',
    }),
  ]);
  const result = response.data.calendars?.[calendarId];
  if (!result || result.errors?.length) throw new Error('No se pudo verificar disponibilidad en Calendar');
  const busy = [...(result.busy || [])];
  for (const event of events) {
    if (event.status === 'cancelled' || (event.transparency === 'transparent' && !eventContact(event))) continue;
    if (event.start?.dateTime && event.end?.dateTime) busy.push({ start: event.start.dateTime, end: event.end.dateTime });
  }
  return busy;
}

function workingHours(date: string) {
  const opening = clinicInstant(date, process.env.CLINIC_OPEN_TIME || '09:00');
  const closing = clinicInstant(date, process.env.CLINIC_CLOSE_TIME || '19:00');
  if (closing.getTime() <= opening.getTime()) throw new Error('Horario de clínica inválido');
  return { opening, closing };
}

function availableSlots(opening: Date, closing: Date, busy: calendar_v3.Schema$TimePeriod[], after: number, duration: number) {
  const slots = [];
  for (let start = opening.getTime(); start + duration <= closing.getTime(); start += 15 * 60_000) {
    const end = start + duration;
    if (start <= after || busy.some(slot => start < Date.parse(slot.end || '') && end > Date.parse(slot.start || ''))) continue;
    const iso = new Date(start).toISOString();
    slots.push({ start: iso, end: new Date(end).toISOString(), label: formatAppointment(iso) });
  }
  return slots;
}

export async function getAvailableSlots(date: string, duration = APPOINTMENT_MINUTES * 60_000) {
  const { opening, closing } = workingHours(date);
  const now = Date.now();
  if (closing.getTime() <= now) return { date, slots: [] };
  const busy = await getBusySlots(opening.toISOString(), closing.toISOString());
  return { date, slots: availableSlots(opening, closing, busy, now, duration) };
}

export async function getUpcomingSlots(after = Date.now(), duration = APPOINTMENT_MINUTES * 60_000) {
  const earliest = Math.max(after, Date.now());
  const days = [];
  for (let date = clinicDate(new Date(earliest)), index = 0; index < 14; index++, date = nextDate(date)) {
    days.push(workingHours(date));
  }
  const busy = await getBusySlots(days[0].opening.toISOString(), days[days.length - 1].closing.toISOString());
  return days.flatMap(({ opening, closing }) => availableSlots(opening, closing, busy, earliest, duration));
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
  const eventId = params.actionId.replaceAll('-', '');
  await calendar.events.insert({
    calendarId,
    requestBody: {
      id: eventId,
      summary: `Cita: ${params.patientName}`,
      visibility: 'private',
      transparency: 'opaque',
      description: `Motivo o tratamiento indicado por el paciente: ${params.reason}`,
      start: { dateTime: slot.start, timeZone: CLINIC_TIMEZONE },
      end: { dateTime: slot.end, timeZone: CLINIC_TIMEZONE },
      extendedProperties: { private: { patientPhone: params.patientPhone } },
    },
  }, { timeout: 10_000 });
  await verifySavedAppointment(eventId, params.patientPhone, slot);
  return slot;
}

export async function findCalendarBooking(actionId: string) {
  return getCalendarAppointment(actionId.replaceAll('-', ''));
}

function calendarErrorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : 0;
}

export async function getCalendarAppointment(eventId: string) {
  const { calendar, calendarId } = getCalendarClient();
  try {
    const { data } = await calendar.events.get({ calendarId, eventId }, { timeout: 8_000 });
    return toAppointment(data);
  } catch (error) {
    if ([404, 410].includes(calendarErrorCode(error))) return null;
    throw error;
  }
}

export function appointmentMatchesSlot(event: CalendarEventData | null, patientPhone: string | undefined, slot: { start: string; end: string } | undefined) {
  return Boolean(event && patientPhone && slot && event.patientPhone === patientPhone &&
    Date.parse(event.start) === Date.parse(slot.start) && Date.parse(event.end) === Date.parse(slot.end));
}

async function verifySavedAppointment(eventId: string, patientPhone: string, slot: { start: string; end: string }, attendanceConfirmed = false) {
  const saved = await getCalendarAppointment(eventId);
  if (saved?.eventId !== eventId || !appointmentMatchesSlot(saved, patientPhone, slot) ||
      saved.attendanceConfirmed !== attendanceConfirmed) {
    throw new Error('No se pudo verificar la cita guardada en Calendar');
  }
}

async function listCalendarEvents(options: calendar_v3.Params$Resource$Events$List) {
  const { calendar, calendarId } = getCalendarClient();
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({
      ...options, calendarId, pageToken, maxResults: 250, singleEvents: true,
      showDeleted: false, orderBy: 'startTime', timeZone: CLINIC_TIMEZONE,
    }, { timeout: 8_000 });
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}

async function listAppointments(options: calendar_v3.Params$Resource$Events$List): Promise<CalendarEventData[]> {
  const events = await listCalendarEvents(options);
  return events.map(toAppointment).filter(appointment => appointment !== null);
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

async function updatePatientAppointment(
  expected: CalendarEventData,
  ownerPhone: string,
  newStart?: string,
) {
  const { calendar, calendarId } = getCalendarClient();
  const eventId = expected.eventId;
  try {
    const { data } = await calendar.events.get({ calendarId, eventId }, { timeout: 8_000 });
    const current = toAppointment(data);
    if (!current || !data.etag || !appointmentMatchesSlot(current, ownerPhone, expected) ||
        Date.parse(current.start) <= Date.now()) {
      return { state: 'changed' } as const;
    }
    if (!newStart && current.attendanceConfirmed) return { state: 'confirmed', label: formatAppointment(current.start) } as const;

    let target = { start: current.start, end: current.end };
    const requestBody: calendar_v3.Schema$Event = {};
    if (newStart) {
      const date = new Date(newStart);
      const duration = Date.parse(current.end) - Date.parse(current.start);
      if (!Number.isFinite(date.getTime()) || !Number.isFinite(duration) || duration <= 0) return { state: 'unavailable' } as const;
      const availability = await getAvailableSlots(clinicDate(date), duration);
      const slot = availability.slots.find(item => item.start === date.toISOString());
      if (!slot || Date.parse(slot.start) === Date.parse(current.start)) return { state: 'unavailable' } as const;
      target = slot;
      requestBody.start = { dateTime: slot.start, timeZone: CLINIC_TIMEZONE };
      requestBody.end = { dateTime: slot.end, timeZone: CLINIC_TIMEZONE };
      requestBody.transparency = 'opaque';
    }
    requestBody.extendedProperties = { private: {
      ...data.extendedProperties?.private,
      attendanceConfirmedFor: newStart ? 'pending' : new Date(current.start).toISOString(),
    } };
    await calendar.events.patch({ calendarId, eventId, requestBody, sendUpdates: 'none' }, {
      headers: { 'If-Match': data.etag }, timeout: 10_000,
    });
    await verifySavedAppointment(eventId, ownerPhone, target, !newStart);
    return { state: 'confirmed', label: formatAppointment(target.start) } as const;
  } catch (error) {
    if ([404, 410, 412].includes(calendarErrorCode(error))) return { state: 'changed' } as const;
    throw error;
  }
}

export function confirmCalendarAttendance(expected: CalendarEventData, ownerPhone: string) {
  return updatePatientAppointment(expected, ownerPhone);
}

export function moveCalendarAppointment(expected: CalendarEventData, ownerPhone: string, newStart: string) {
  return updatePatientAppointment(expected, ownerPhone, newStart);
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
