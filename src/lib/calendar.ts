import { google } from 'googleapis';

const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';

// 1. OBTENER HORARIOS DISPONIBLES
export async function getAvailableSlots(dateStr: string, durationMinutes = 45) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const calendar = google.calendar({ version: 'v3', auth });

  const startOfDay = new Date(`${dateStr}T09:00:00-06:00`); 
  const endOfDay = new Date(`${dateStr}T19:00:00-06:00`); 

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      timeZone: TIMEZONE,
      items: [{ id: process.env.GOOGLE_CALENDAR_ID as string }],
    },
  });

  const busySlots = response.data.calendars?.[process.env.GOOGLE_CALENDAR_ID as string]?.busy || [];
  return { date: dateStr, busySlots };
}

// 2. CREAR CITA
export async function createCalendarAppointment(params: {
  patientName: string;
  patientPhone: string;
  startTime: string;
  endTime: string;
  reason?: string;
  clinicalSummary?: string;
  isUrgent?: boolean;
}) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const calendar = google.calendar({ version: 'v3', auth });

  const title = params.isUrgent ? `[URGENTE] Cita: ${params.patientName}` : `Cita: ${params.patientName}`;
  const description = `Teléfono: ${params.patientPhone}\nMotivo: ${params.reason || 'No especificado'}\nResumen: ${params.clinicalSummary || 'N/A'}`;

  const event = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID as string,
    requestBody: {
      summary: title,
      description,
      start: { dateTime: params.startTime, timeZone: TIMEZONE },
      end: { dateTime: params.endTime, timeZone: TIMEZONE },
      extendedProperties: {
        private: { patientPhone: params.patientPhone },
      },
    },
  });

  return { success: true, eventId: event.data.id, message: 'Cita agendada correctamente.' };
}

// 3. OBTENER TODAS LAS CITAS DE UN RANGO (Para el Admin)
export async function getAppointmentsByDateRange(startIso: string, endIso: string) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const calendar = google.calendar({ version: 'v3', auth });

  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID as string,
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (response.data.items || []).map((event: any) => ({
    eventId: event.id,
    summary: event.summary,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    patientPhone: event.extendedProperties?.private?.patientPhone,
  }));
}

// 4. OBTENER CITAS DE UN PACIENTE ESPECÍFICO (Para el Paciente)
export async function getPatientAppointments(patientPhone: string) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const calendar = google.calendar({ version: 'v3', auth });
  
  const timeMin = new Date().toISOString(); 
  
  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID as string,
    timeMin,
    privateExtendedProperty: [`patientPhone=${patientPhone}`],
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (response.data.items || []).map((event: any) => ({
    eventId: event.id,
    summary: event.summary,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
  }));
}

// 5. CANCELAR EVENTO
export async function cancelCalendarEvent(eventId: string) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const calendar = google.calendar({ version: 'v3', auth });

  let patientName = '';
  let patientPhone = '';
  try {
    const event = await calendar.events.get({
      calendarId: process.env.GOOGLE_CALENDAR_ID as string,
      eventId,
    });
    patientName = event.data.summary?.replace('[URGENTE] Cita: ', '')?.replace('Cita: ', '') || '';
    patientPhone = event.data.extendedProperties?.private?.patientPhone || '';
  } catch (error) {
    console.warn('No se pudo recuperar información del evento antes de borrarlo.', error);
  }

  await calendar.events.delete({
    calendarId: process.env.GOOGLE_CALENDAR_ID as string,
    eventId,
  });

  return { patientName, patientPhone };
}