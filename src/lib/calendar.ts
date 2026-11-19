import { google } from 'googleapis';

const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';

// Interfaces estrictas para evitar errores de compilación en Vercel
export interface CalendarEventData {
  eventId: string;
  summary: string;
  start: string;
  end: string;
  patientPhone: string;
}

function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

export async function getAvailableSlots(dateStr: string, durationMinutes = 45) {
  const calendar = getCalendarClient();
  const startOfDay = new Date(`${dateStr}T09:00:00-06:00`); 
  const endOfDay = new Date(`${dateStr}T19:00:00-06:00`); 
  const calendarId = String(process.env.GOOGLE_CALENDAR_ID);

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      timeZone: TIMEZONE,
      items: [{ id: calendarId }],
    },
  });

  const busySlots = response.data.calendars?.[calendarId]?.busy || [];
  return { date: dateStr, busySlots };
}

export async function createCalendarAppointment(params: {
  patientName: string;
  patientPhone: string;
  startTime: string;
  endTime: string;
  reason?: string;
  clinicalSummary?: string;
  isUrgent?: boolean;
}) {
  const calendar = getCalendarClient();
  const title = params.isUrgent ? `[URGENTE] Cita: ${params.patientName}` : `Cita: ${params.patientName}`;
  const description = `Teléfono: ${params.patientPhone}\nMotivo: ${params.reason || 'No especificado'}\nResumen: ${params.clinicalSummary || 'N/A'}`;

  const event = await calendar.events.insert({
    calendarId: String(process.env.GOOGLE_CALENDAR_ID),
    requestBody: {
      summary: title,
      description,
      start: { dateTime: params.startTime, timeZone: TIMEZONE },
      end: { dateTime: params.endTime, timeZone: TIMEZONE },
      extendedProperties: { private: { patientPhone: params.patientPhone } },
    },
  });

  return { success: true, eventId: event.data.id, message: 'Cita agendada correctamente.' };
}

export async function getAppointmentsByDateRange(startIso: string, endIso: string): Promise<CalendarEventData[]> {
  const calendar = getCalendarClient();
  const response = await calendar.events.list({
    calendarId: String(process.env.GOOGLE_CALENDAR_ID),
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const items = response.data.items || [];
  return items.map((event) => ({
    eventId: String(event.id),
    summary: String(event.summary || 'Cita'),
    start: String(event.start?.dateTime || event.start?.date),
    end: String(event.end?.dateTime || event.end?.date),
    patientPhone: String(event.extendedProperties?.private?.patientPhone || ''),
  }));
}

export async function getPatientAppointments(patientPhone: string): Promise<CalendarEventData[]> {
  const calendar = getCalendarClient();
  const timeMin = new Date().toISOString(); 
  
  const response = await calendar.events.list({
    calendarId: String(process.env.GOOGLE_CALENDAR_ID),
    timeMin,
    privateExtendedProperty: [`patientPhone=${patientPhone}`],
    singleEvents: true,
    orderBy: 'startTime',
  });

  const items = response.data.items || [];
  return items.map((event) => ({
    eventId: String(event.id),
    summary: String(event.summary || 'Cita'),
    start: String(event.start?.dateTime || event.start?.date),
    end: String(event.end?.dateTime || event.end?.date),
    patientPhone: String(event.extendedProperties?.private?.patientPhone || ''),
  }));
}

export async function cancelCalendarEvent(eventId: string) {
  const calendar = getCalendarClient();
  let patientName = '';
  let patientPhone = '';
  
  try {
    const event = await calendar.events.get({
      calendarId: String(process.env.GOOGLE_CALENDAR_ID),
      eventId,
    });
    patientName = String(event.data.summary || '').replace(/\[URGENTE\]\s*Cita:\s*/i, '').replace(/Cita:\s*/i, '');
    patientPhone = String(event.data.extendedProperties?.private?.patientPhone || '');
  } catch (error) {
    console.warn('No se pudieron obtener datos del evento previo a borrarlo.', error);
  }

  await calendar.events.delete({
    calendarId: String(process.env.GOOGLE_CALENDAR_ID),
    eventId,
  });

  return { patientName, patientPhone };
}