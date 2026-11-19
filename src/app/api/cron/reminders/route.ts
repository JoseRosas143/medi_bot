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
    // Buscar citas para las próximas 24 horas (margen de 23 a 25 horas)
    const startIso = new Date(now.getTime() + 23 * 60 * 60 * 1000).toISOString();
    const endIso = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();

    const appointments = await getAppointmentsByDateRange(startIso, endIso);
    let sent = 0;

    for (const appt of appointments) {
      const patientPhone = appt.patientPhone;
      if (!patientPhone) continue;

      // Extraer el nombre del summary (ej. "Cita: José" -> "José")
      const patientName = appt.summary?.replace(/\[URGENTE\]\s*Cita:\s*/i, '')?.replace(/Cita:\s*/i, '') || 'Paciente';
      
      // Formatear la fecha para que Meta la envíe amigable
      const dateObj = new Date(appt.start as string);
      const formattedTime = new Intl.DateTimeFormat('es-MX', {
        timeZone: process.env.CLINIC_TIMEZONE || 'America/Mexico_City',
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).format(dateObj);

      try {
        await sendWhatsAppTemplate(
          patientPhone,
          'cita_recordatorio',
          [patientName, 'nuestra clínica', formattedTime]
        );
        
        await supabaseAdmin.from('chat_messages').insert({
          patient_phone: patientPhone,
          role: 'assistant',
          content: `⏰ (Sistema) Recordatorio enviado automáticamente para la cita del ${formattedTime}.`
        });
        sent++;
      } catch (err) {
        console.warn(`[Cron] No se pudo enviar recordatorio a ${patientPhone}:`, err);
      }
    }

    return NextResponse.json({ success: true, reminders_sent: sent });
  } catch (error) {
    console.error('[Cron] Error interno:', error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}