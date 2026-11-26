import { google, type calendar_v3 } from 'googleapis';
import { clinicDate, clinicInstant, CLINIC_TIMEZONE, formatAppointment, nextDate } from '@/lib/clinic-time';
import { comparableWhatsApp, isWhatsAppPhone, phoneDigits } from '@/lib/whatsapp';
import { weeklyHours, type WeeklyHours } from '@/lib/clinic-configuration';
import { getScheduleBlocks } from '@/lib/schedule-blocks';
import { DEFAULT_APPOINTMENT_MINUTES, getSchedulableTreatment } from '@/lib/treatment-duration';

export type VisitStatus = 'arrived' | 'no_show';

export interface CalendarEventData {
  eventId: string;
  summary: string;
  start: string;
  end: string;
  patientPhone: string;
  attendanceConfirmed?: boolean;
  visitStatus?: VisitStatus;
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

function withPatientPhone(description: string | null | undefined, phone: string) {
  const notes = (description || '').split('\n')
    .filter(line => !/^WhatsApp del paciente: \+?\d+\s*$/.test(line)).join('\n').trimEnd();
  return [notes, `WhatsApp del paciente: +${phone}`].filter(Boolean).join('\n');
}

function toAppointment(event: calendar_v3.Schema$Event): CalendarEventData | null {
  const { id, start, end, summary, status } = event;
  if (status === 'cancelled' || !id || !start?.dateTime || !end?.dateTime) return null;
  const metadata = event.extendedProperties?.private;
  const confirmedFor = metadata?.attendanceConfirmedFor;
  const result = metadata?.visitStatus;
  return {
    eventId: id, summary: summary || 'Cita', start: start.dateTime, end: end.dateTime, patientPhone: eventContact(event),
    attendanceConfirmed: Boolean(confirmedFor && Date.parse(confirmedFor) === Date.parse(start.dateTime)),
    visitStatus: (result === 'arrived' || result === 'no_show') &&
      Date.parse(metadata?.visitStatusFor || '') === Date.parse(start.dateTime) ? result : undefined,
  };
}

async function getBusySlots(start: string, end: string) {
  const { calendar, calendarId } = getCalendarClient();
  const [response, events, blocks] = await Promise.all([
    calendar.freebusy.query({
      requestBody: { timeMin: start, timeMax: end, timeZone: CLINIC_TIMEZONE, items: [{ id: calendarId }] },
    }, { timeout: 8_000 }),
    listCalendarEvents({
      timeMin: start, timeMax: end, eventTypes: ['default'],
      fields: 'nextPageToken,items(start/dateTime,end/dateTime,status,transparency,extendedProperties/private)',
    }),
    getScheduleBlocks(start, end),
  ]);
  const result = response.data.calendars?.[calendarId];
  if (!result || result.errors?.length) throw new Error('No se pudo verificar disponibilidad en Calendar');
  const busy = [...(result.busy || []), ...blocks.map(block => ({ start: block.starts_at, end: block.ends_at }))];
  for (const event of events) {
    if (event.status === 'cancelled' || (event.transparency === 'transparent' && !eventContact(event))) continue;
    if (event.start?.dateTime && event.end?.dateTime) busy.push({ start: event.start.dateTime, end: event.end.dateTime });
  }
  return busy;
}

function workingHours(date: string, week: WeeklyHours) {
  const day = week.find(item => item.weekday === new Date(`${date}T00:00:00Z`).getUTCDay());
  if (!day?.opens_at || !day.closes_at) return null;
  const opening = clinicInstant(date, day.opens_at.slice(0, 5));
  const closing = clinicInstant(date, day.closes_at.slice(0, 5));
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

export async function getAvailableSlots(date: string, duration = DEFAULT_APPOINTMENT_MINUTES * 60_000) {
  const window = workingHours(date, await weeklyHours());
  if (!window) return { date, closed: true, slots: [] };
  const { opening, closing } = window;
  const now = Date.now();
  if (closing.getTime() <= now) return { date, slots: [] };
  const busy = await getBusySlots(opening.toISOString(), closing.toISOString());
  return { date, slots: availableSlots(opening, closing, busy, now, duration) };
}

export const upcomingSlotDays = 14;

export async function getUpcomingSlots(after = Date.now(), duration = DEFAULT_APPOINTMENT_MINUTES * 60_000, fromDate?: string) {
  const earliest = Math.max(after, Date.now());
  const week = await weeklyHours();
  const days = [];
  for (let date = fromDate ?? clinicDate(new Date(earliest)), index = 0; index < upcomingSlotDays; index++, date = nextDate(date)) {
    const day = workingHours(date, week);
    if (day && day.closing.getTime() > earliest) days.push(day);
  }
  if (!days.length) return [];
  const busy = await getBusySlots(days[0].opening.toISOString(), days[days.length - 1].closing.toISOString());
  return days.flatMap(({ opening, closing }) => availableSlots(opening, closing, busy, earliest, duration));
}

export async function createCalendarAppointment(params: {
  actionId: string; patientName: string; patientPhone: string; startTime: string; reason: string;
  durationMinutes?: number; treatmentId?: number;
}) {
  const { calendar, calendarId } = getCalendarClient();
  const start = new Date(params.startTime);
  if (!Number.isFinite(start.getTime())) throw new Error('Hora inválida');
  const duration = params.durationMinutes ?? DEFAULT_APPOINTMENT_MINUTES;
  if (!Number.isInteger(duration) || duration < 15 || duration > 480) throw new Error('Duración de cita inválida');
  if (params.treatmentId !== undefined) {
    const treatment = await getSchedulableTreatment(params.treatmentId);
    if (!treatment || treatment.duration_minutes !== duration) return null;
  }
  const availability = await getAvailableSlots(clinicDate(start), duration * 60_000);
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
      description: withPatientPhone(`Motivo o tratamiento indicado por el paciente: ${params.reason}`, params.patientPhone),
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

export async function getPatientVisitHistory(patientPhone: string, from: string, to: string) {
  const canonical = comparableWhatsApp(patientPhone);
  const numbers = /^52\d{10}$/.test(canonical) ? [canonical, `521${canonical.slice(2)}`] : [canonical];
  const histories = await Promise.all(numbers.map(phone => listAppointments({
    timeMin: from, timeMax: to, privateExtendedProperty: [`patientPhone=${phone}`],
  })));
  return histories.flat().filter(event => numbers.includes(event.patientPhone));
}

export async function findUpcomingAppointmentsByWhatsApp(phone: string) {
  const canonical = comparableWhatsApp(phone);
  const numbers = /^52\d{10}$/.test(canonical) ? [canonical, `521${canonical.slice(2)}`] : [canonical];
  const appointments = await Promise.all(numbers.map(getPatientAppointments));
  return appointments.flat().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
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

export async function recordCalendarVisit(expected: CalendarEventData, status: VisitStatus) {
  const { calendar, calendarId } = getCalendarClient();
  const eventId = expected.eventId;
  try {
    const { data } = await calendar.events.get({ calendarId, eventId }, { timeout: 8_000 });
    const current = toAppointment(data);
    if (!current || current.eventId !== eventId || !data.etag ||
        current.visitStatus !== expected.visitStatus || current.summary !== expected.summary ||
        current.patientPhone !== expected.patientPhone || Date.parse(current.start) !== Date.parse(expected.start) ||
        Date.parse(current.end) !== Date.parse(expected.end) || clinicDate(new Date(current.start)) !== clinicDate()) return 'changed';
    if (status === 'no_show' && Date.parse(current.start) > Date.now()) return 'too_early';
    if (current.visitStatus === status) return 'saved';
    await calendar.events.patch({ calendarId, eventId, sendUpdates: 'none', requestBody: {
      extendedProperties: { private: {
        ...data.extendedProperties?.private, visitStatus: status, visitStatusFor: new Date(current.start).toISOString(),
      } },
    } }, { headers: { 'If-Match': data.etag }, timeout: 10_000 });
    const saved = await getCalendarAppointment(eventId);
    return saved?.visitStatus === status && Date.parse(saved.start) === Date.parse(current.start) ? 'saved' : 'changed';
  } catch (error) {
    if ([404, 410, 412].includes(calendarErrorCode(error))) return 'changed';
    throw error;
  }
}

type CalendarClient = ReturnType<typeof getCalendarClient>;

async function getEditableAppointment({ calendar, calendarId }: CalendarClient, expected: CalendarEventData, ownerPhone?: string) {
  const { data } = await calendar.events.get({ calendarId, eventId: expected.eventId }, { timeout: 8_000 });
  const current = toAppointment(data);
  if (!current || current.eventId !== expected.eventId || Date.parse(current.start) <= Date.now() ||
      Date.parse(current.start) !== Date.parse(expected.start) || Date.parse(current.end) !== Date.parse(expected.end) ||
      current.summary !== expected.summary || current.patientPhone !== expected.patientPhone ||
      (ownerPhone && current.patientPhone !== ownerPhone)) {
    return null;
  }
  if (!data.etag) throw new Error('Calendar no devolvió la versión de la cita');
  return { event: current, data, etag: data.etag };
}

async function updateAppointmentContact(
  { calendar, calendarId }: CalendarClient,
  current: NonNullable<Awaited<ReturnType<typeof getEditableAppointment>>>,
  correctedPhone: string,
) {
  const { event, data, etag } = current;
  const eventId = event.eventId;
  const description = withPatientPhone(data.description, correctedPhone);
  const contactChanged = comparableWhatsApp(event.patientPhone) !== comparableWhatsApp(correctedPhone);
  await calendar.events.patch({ calendarId, eventId, sendUpdates: 'none', requestBody: {
      visibility: 'private', description,
      extendedProperties: { private: {
        ...data.extendedProperties?.private, patientPhone: correctedPhone,
        ...(contactChanged ? { attendanceConfirmedFor: 'pending' } : {}),
      } },
  } }, { headers: { 'If-Match': etag }, timeout: 10_000 });
  const { data: saved } = await calendar.events.get({ calendarId, eventId }, { timeout: 8_000 });
  const updated = toAppointment(saved);
  if (!updated || updated.eventId !== eventId || updated.summary !== event.summary ||
      !appointmentMatchesSlot(updated, correctedPhone, event) || saved.visibility !== 'private' ||
      saved.description !== description || !saved.etag) {
    throw new Error('Calendar no permitió verificar el WhatsApp corregido');
  }
  return { event: updated, etag: saved.etag };
}

export async function saveCalendarAppointmentContact(expected: CalendarEventData, correctedPhone: string) {
  const client = getCalendarClient();
  try {
    const current = await getEditableAppointment(client, expected);
    return current ? (await updateAppointmentContact(client, current, correctedPhone)).event : null;
  } catch (error) {
    if ([404, 410, 412].includes(calendarErrorCode(error))) return null;
    throw error;
  }
}

export async function cancelCalendarEvent(expected: CalendarEventData, ownerPhone?: string, correctedPhone?: string) {
  const client = getCalendarClient();
  const current = await getEditableAppointment(client, expected, ownerPhone);
  if (!current) return null;
  const target = correctedPhone ? await updateAppointmentContact(client, current, correctedPhone) : current;
  await client.calendar.events.delete({ calendarId: client.calendarId, eventId: expected.eventId, sendUpdates: 'none' }, {
    headers: { 'If-Match': target.etag }, timeout: 10_000,
  });
  return target.event;
}
