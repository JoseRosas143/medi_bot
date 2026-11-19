import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText } from '@/lib/whatsapp';
import { runAdminAgent } from '@/lib/handlers/adminHandler';
import { runPatientAgent } from '@/lib/handlers/patientHandler';

export type IncomingMessage = {
  from: string;
  messageId: string;
  content: string;
  contextMessageId?: string;
};

const EMERGENCY_WORDS = /\b(emergencia|urgencia|sangrado|respirar|dolor de pecho)\b/i;

export async function handlePatientMessage(message: IncomingMessage): Promise<void> {
  // Solo consultamos si el paciente ya está en modo espera de humano
  let { data: patient } = await supabase.from('patients').select('chat_mode, full_name').eq('phone', message.from).maybeSingle();
  
  // Si está hablando con el doctor, pausamos a la IA
  if (patient?.chat_mode === 'WAITING_HUMAN') {
    await supabase.from('chat_messages').insert({ patient_phone: message.from, role: 'user', content: message.content });
    const adminPhone = process.env.ADMIN_PHONE_NUMBER;
    if (adminPhone) {
      const wamid = await sendWhatsAppText(adminPhone, `🩺 *Mensaje de ${patient.full_name || message.from}:*\n"${message.content}"\n_Desliza para responder._`);
      await supabase.from('escalation_mappings').upsert({ wa_message_id: wamid, patient_phone: message.from });
    }
    return;
  }

  // Triaje rápido de emergencia
  if (EMERGENCY_WORDS.test(message.content)) {
    await supabase.from('chat_messages').insert({ patient_phone: message.from, role: 'user', content: message.content });
    const msg = 'Si presentas una emergencia grave, acude a urgencias de inmediato. Para agendar una cita prioritaria, dímelo por este medio.';
    await sendWhatsAppText(message.from, msg);
    await supabase.from('chat_messages').insert({ patient_phone: message.from, role: 'assistant', content: msg });
    return;
  }

  // Delegar al Agente del Paciente (Él se encargará de crearlo en la BD de forma segura)
  await runPatientAgent(message);
}

export async function handleAdminMessage(message: IncomingMessage): Promise<void> {
  if (message.contextMessageId) {
    const { data: mapping } = await supabase.from('escalation_mappings').select('patient_phone')
      .eq('wa_message_id', message.contextMessageId).maybeSingle();

    if (mapping) {
      const text = message.content.trim().toLowerCase();
      if (text === 'cerrar' || text === 'listo') {
        await supabase.from('patients').update({ chat_mode: 'AI_ACTIVE' }).eq('phone', mapping.patient_phone);
        await sendWhatsAppText(message.from, '✅ Chat cerrado. La IA retoma el control.');
        return;
      }
      await sendWhatsAppText(mapping.patient_phone, message.content);
      await supabase.from('chat_messages').insert({ patient_phone: mapping.patient_phone, role: 'doctor', content: message.content });
      await sendWhatsAppText(message.from, '✅ Enviado.');
      return;
    }
  }
  await runAdminAgent(message);
}