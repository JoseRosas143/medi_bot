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
  let { data: patient } = await supabase.from('patients').select('chat_mode, full_name').eq('phone', message.from).maybeSingle();
  
  // MODO HUMANO: Si el paciente está hablando con el doctor
  if (patient?.chat_mode === 'WAITING_HUMAN') {
    // AHORA EL PACIENTE TAMBIÉN PUEDE CERRAR EL CHAT DICIENDO "CERRAR"
    const text = message.content.trim().toLowerCase();
    if (text === 'cerrar conversación' || text === 'cerrar' || text === 'listo') {
      await supabase.from('patients').update({ chat_mode: 'AI_ACTIVE' }).eq('phone', message.from);
      await sendWhatsAppText(message.from, '🤖 El especialista ha dejado el chat. He retomado el control como tu Asistente Virtual. ¿En qué te ayudo?');
      return;
    }

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

  await runPatientAgent(message);
}

export async function handleAdminMessage(message: IncomingMessage): Promise<void> {
  if (message.contextMessageId) {
    const { data: mapping } = await supabase.from('escalation_mappings').select('patient_phone')
      .eq('wa_message_id', message.contextMessageId).maybeSingle();

    if (mapping) {
      const text = message.content.trim().toLowerCase();
      // EL DOCTOR CIERRA EL CHAT
      if (text === 'cerrar' || text === 'listo') {
        await supabase.from('patients').update({ chat_mode: 'AI_ACTIVE' }).eq('phone', mapping.patient_phone);
        await sendWhatsAppText(message.from, '✅ Chat cerrado. La IA retoma el control del paciente.');
        await sendWhatsAppText(mapping.patient_phone, '🤖 El especialista ha cerrado el chat. Vuelves a hablar conmigo, el Asistente Virtual.');
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