import { google } from 'googleapis';

const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';

function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

export async function getAvailableSlots(dateStr: string, durationMinutes = 45) {
  const calendar = getCalendarClient();
  const startOfDay = new Date(`${dateStr}T09:00:00-06:00`); 
  const endOfDay = new Date(`${dateStr}T19:00:00-06:00`); 
  const calendarId = process.env.GOOGLE_CALENDAR_ID as string;

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
    calendarId: process.env.GOOGLE_CALENDAR_ID as string,
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

export async function getAppointmentsByDateRange(startIso: string, endIso: string) {
  const calendar = getCalendarClient();
  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID as string,
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (response.data.items || []).map((event) => ({
    eventId: event.id,
    summary: event.summary,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    patientPhone: event.extendedProperties?.private?.patientPhone,
  }));
}

export async function getPatientAppointments(patientPhone: string) {
  const calendar = getCalendarClient();
  const timeMin = new Date().toISOString(); 
  
  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID as string,
    timeMin,
    privateExtendedProperty: [`patientPhone=${patientPhone}`],
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (response.data.items || []).map((event) => ({
    eventId: event.id,
    summary: event.summary,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
  }));
}

export async function cancelCalendarEvent(eventId: string) {
  const calendar = getCalendarClient();
  let patientName = '';
  let patientPhone = '';
  
  try {
    const event = await calendar.events.get({
      calendarId: process.env.GOOGLE_CALENDAR_ID as string,
      eventId,
    });
    patientName = event.data.summary?.replace(/\[URGENTE\]\s*Cita:\s*/i, '')?.replace(/Cita:\s*/i, '') || '';
    patientPhone = event.data.extendedProperties?.private?.patientPhone || '';
  } catch (error) {
    console.warn('Advertencia: No se pudo obtener datos previos del evento.', error);
  }

  await calendar.events.delete({
    calendarId: process.env.GOOGLE_CALENDAR_ID as string,
    eventId,
  });

  return { patientName, patientPhone };
}