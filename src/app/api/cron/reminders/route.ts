import { NextResponse } from 'next/server';
import { getAppointmentsByDateRange } from '@/lib/calendar';
import { sendWhatsAppTemplate } from '@/lib/whatsapp';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('No autorizado', { status: 401 });
  }

  try {
    const now = new Date();
    const startIso = new Date(now.getTime() + 23 * 60 * 60 * 1000).toISOString();
    const endIso = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();

    const appointments = await getAppointmentsByDateRange(startIso, endIso);
    let sent = 0;

    for (const appt of appointments) {
      if (!appt.patientPhone) continue;

      // Variables locales procesadas a partir de la interfaz de CalendarEventData
      const localPatientName = appt.summary.replace(/\[URGENTE\]\s*Cita:\s*/i, '').replace(/Cita:\s*/i, '') || 'Paciente';
      const dateObj = new Date(appt.start);
      const localFormattedTime = new Intl.DateTimeFormat('es-MX', {
        timeZone: process.env.CLINIC_TIMEZONE || 'America/Mexico_City',
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).format(dateObj);

      try {
        await sendWhatsAppTemplate(
          appt.patientPhone,
          'cita_recordatorio',
          [localPatientName, 'nuestra clínica', localFormattedTime]
        );
        
        await supabaseAdmin.from('chat_messages').insert({
          patient_phone: appt.patientPhone,
          role: 'assistant',
          content: `⏰ Recordatorio automático enviado para la cita del ${localFormattedTime}.`
        });
        sent++;
      } catch (err) {
        console.warn(`[Cron] Falló recordatorio para ${appt.patientPhone}:`, err);
      }
    }

    return NextResponse.json({ success: true, reminders_sent: sent });
  } catch (error) {
    console.error('[Cron Error]:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}