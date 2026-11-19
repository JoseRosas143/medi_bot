import { google } from 'googleapis';
import type {
  CalendarAppointment,
  CalendarSlot,
  CancelledAppointmentInfo,
  CreateAppointmentInput,
} from '@/types/database';

const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';
// Desfase estándar de México Centro (-06:00). Ajusta si tu clínica está en otra zona.
const TIMEZONE_OFFSET = '-06:00';

function getCalendarClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error('Faltan credenciales de Google Service Account en variables de entorno.');
  }

  const auth = new google.auth.JWT({
    email,
    key: rawKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth });
}

function getCalendarId(): string {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    throw new Error('Falta GOOGLE_CALENDAR_ID en variables de entorno.');
  }
  return calendarId;
}

function formatReadableDateTime(isoString: string): string {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatReadableTime(isoString: string): string {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Devuelve bloques horarios libres entre 09:00 y 19:00 para una fecha YYYY-MM-DD.
 */
export async function getAvailableSlots(
  dateStr: string,
  durationMinutes = 45
): Promise<CalendarSlot[]> {
  const calendar = getCalendarClient();
  const calendarId = getCalendarId();

  const dayStart = `${dateStr}T09:00:00${TIMEZONE_OFFSET}`;
  const dayEnd = `${dateStr}T19:00:00${TIMEZONE_OFFSET}`;

  const freeBusyRes = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart,
      timeMax: dayEnd,
      timeZone: TIMEZONE,
      items: [{ id: calendarId }],
    },
  });

  const busyPeriods = freeBusyRes.data.calendars?.[calendarId]?.busy ?? [];
  const slots: CalendarSlot[] = [];

  let cursor = new Date(dayStart).getTime();
  const endLimit = new Date(dayEnd).getTime();
  const stepMs = durationMinutes * 60 * 1000;

  while (cursor + stepMs <= endLimit) {
    const slotStartMs = cursor;
    const slotEndMs = cursor + stepMs;

    const hasConflict = busyPeriods.some((busy) => {
      if (!busy.start || !busy.end) return false;
      const busyStart = new Date(busy.start).getTime();
      const busyEnd = new Date(busy.end).getTime();
      return slotStartMs < busyEnd && slotEndMs > busyStart;
    });

    if (!hasConflict) {
      const startIso = new Date(slotStartMs).toISOString();
      const endIso = new Date(slotEndMs).toISOString();
      slots.push({
        start: startIso,
        end: endIso,
        label: `${formatReadableTime(startIso)} - ${formatReadableTime(endIso)}`,
      });
    }

    cursor += stepMs;
  }

  return slots;
}

/**
 * Verifica disponibilidad exacta (anti double-booking) y crea la cita en Google Calendar.
 */
export async function createCalendarAppointment(
  input: CreateAppointmentInput
): Promise<{ eventId: string; formattedDateTime: string }> {
  const calendar = getCalendarClient();
  const calendarId = getCalendarId();

  // 1. Verificación rápida de disponibilidad exacta para evitar empalmes
  const freeBusyRes = await calendar.freebusy.query({
    requestBody: {
      timeMin: input.startTime,
      timeMax: input.endTime,
      timeZone: TIMEZONE,
      items: [{ id: calendarId }],
    },
  });

  const busy = freeBusyRes.data.calendars?.[calendarId]?.busy ?? [];
  if (busy.length > 0) {
    throw new Error('SLOT_OCCUPIED');
  }

  // 2. Crear evento con resumen clínico y propiedades privadas para recordatorios/cancelaciones
  const title = input.isUrgent
    ? `[URGENTE] Cita: ${input.patientName}`
    : `Cita: ${input.patientName}`;

  const description = [
    `Paciente: ${input.patientName}`,
    `Teléfono: ${input.patientPhone}`,
    `Motivo: ${input.reason}`,
    `Prioridad: ${input.isUrgent ? 'URGENCIA CLÍNICA' : 'Consulta regular'}`,
    `Estado: Confirmada por Asistente IA`,
    '',
    `Resumen Clínico Pre-Consulta:`,
    input.clinicalSummary,
  ].join('\n');

  const eventRes = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      description,
      start: {
        dateTime: input.startTime,
        timeZone: TIMEZONE,
      },
      end: {
        dateTime: input.endTime,
        timeZone: TIMEZONE,
      },
      extendedProperties: {
        private: {
          patientPhone: input.patientPhone,
          patientName: input.patientName,
          reason: input.reason,
          isUrgent: String(input.isUrgent),
        },
      },
    },
  });

  if (!eventRes.data.id) {
    throw new Error('Google Calendar no devolvió un ID de evento.');
  }

  return {
    eventId: eventRes.data.id,
    formattedDateTime: formatReadableDateTime(input.startTime),
  };
}

/**
 * Lista las citas agendadas en un rango de tiempo (ej. todo el día de hoy).
 */
export async function getAppointmentsByDateRange(
  startIso: string,
  endIso: string
): Promise<CalendarAppointment[]> {
  const calendar = getCalendarClient();
  const calendarId = getCalendarId();

  const res = await calendar.events.list({
    calendarId,
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TIMEZONE,
  });

  const items = res.data.items ?? [];

  return items
    .filter((ev) => Boolean(ev.id && ev.start?.dateTime))
    .map((ev) => {
      const start = ev.start!.dateTime!;
      const end = ev.end?.dateTime ?? start;
      const priv = ev.extendedProperties?.private ?? {};
      const patientName =
        priv.patientName ||
        (ev.summary ?? 'Paciente').replace(/^\[URGENTE\]\s*Cita:\s*/i, '').replace(/^Cita:\s*/i, '');

      return {
        eventId: ev.id!,
        summary: ev.summary ?? `Cita: ${patientName}`,
        start,
        end,
        formattedTime: formatReadableTime(start),
        patientName,
        patientPhone: priv.patientPhone ?? null,
        reason: priv.reason ?? 'No especificado',
      };
    });
}

/**
 * Busca citas futuras por fecha (YYYY-MM-DD) y/o nombre de paciente para cancelación.
 */
export async function findAppointments(params: {
  dateStr?: string;
  patientName?: string;
}): Promise<CalendarAppointment[]> {
  const nowIso = new Date().toISOString();
  const timeMin = params.dateStr
    ? `${params.dateStr}T00:00:00${TIMEZONE_OFFSET}`
    : nowIso;
  const timeMax = params.dateStr
    ? `${params.dateStr}T23:59:59${TIMEZONE_OFFSET}`
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(); // Próximos 60 días

  const appointments = await getAppointmentsByDateRange(timeMin, timeMax);

  if (!params.patientName) {
    return appointments;
  }

  const needle = params.patientName.toLowerCase().trim();
  return appointments.filter(
    (apt) =>
      apt.patientName.toLowerCase().includes(needle) ||
      apt.summary.toLowerCase().includes(needle)
  );
}

/**
 * Obtiene los datos del paciente de un evento y lo elimina de Google Calendar.
 */
export async function cancelCalendarEvent(
  eventId: string
): Promise<CancelledAppointmentInfo> {
  const calendar = getCalendarClient();
  const calendarId = getCalendarId();

  const existing = await calendar.events.get({
    calendarId,
    eventId,
  });

  const ev = existing.data;
  const priv = ev.extendedProperties?.private ?? {};
  const patientName =
    priv.patientName ||
    (ev.summary ?? 'Paciente').replace(/^\[URGENTE\]\s*Cita:\s*/i, '').replace(/^Cita:\s*/i, '');
  const patientPhone = priv.patientPhone ?? null;
  const startIso = ev.start?.dateTime ?? ev.start?.date ?? new Date().toISOString();

  await calendar.events.delete({
    calendarId,
    eventId,
  });

  return {
    eventId,
    patientName,
    patientPhone,
    appointmentDateText: formatReadableDateTime(startIso),
  };
}