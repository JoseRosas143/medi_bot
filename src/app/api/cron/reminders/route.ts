import { NextResponse } from 'next/server';
import { getAppointmentsByDateRange } from '@/lib/calendar';
import { sendWhatsAppTemplate } from '@/lib/whatsapp';
import { supabaseAdmin as supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('No autorizado', { status: 401 });
  }

  try {
    const now = new Date();
    // Buscamos citas que ocurran exactamente entre 23 y 24 horas a partir de este momento
    const tomorrowStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const tomorrowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const appointments = await getAppointmentsByDateRange(
      tomorrowStart.toISOString(),
      tomorrowEnd.toISOString()
    );

    const { data: settings } = await supabase.from('bot_settings').select('bot_name').eq('id', 1).single();
    const clinicName = settings?.bot_name || 'la clínica';

    let sentCount = 0;

    for (const apt of appointments) {
      if (!apt.patientPhone) continue;

      try {
        await sendWhatsAppTemplate(
          apt.patientPhone,
          'cita_recordatorio', // Nombre de la plantilla en Meta
          [apt.patientName, clinicName, apt.formattedTime]
        );
        
        // Guardamos el registro en el chat
        await supabase.from('chat_messages').insert({
          patient_phone: apt.patientPhone,
          role: 'assistant',
          content: `⏰ Recordatorio enviado para la cita de mañana a las ${apt.formattedTime}.`
        });
        
        sentCount++;
      } catch (err) {
        console.error(`Error enviando recordatorio a ${apt.patientPhone}:`, err);
      }
    }

    return NextResponse.json({ success: true, reminders_sent: sentCount });
  } catch (error) {
    console.error('Cron Error:', error);
    return NextResponse.json({ success: false, error: 'Internal Server Error' }, { status: 500 });
  }
}