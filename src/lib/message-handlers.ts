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

const HUMAN_REQUEST = /\b(humano|persona|doctor|doctora|asesor|recepci[oó]n)\b/i;
const EMERGENCY_WORDS = /\b(emergencia|urgencia|sangrado intenso|dificultad para respirar|dolor de pecho)\b/i;

async function persistMessage(
  patientPhone: string,
  role: 'user' | 'assistant' | 'doctor',
  content: string
) {
  const { error } = await supabase.from('chat_messages').insert({
    patient_phone: patientPhone,
    role,
    content,
  });
  if (error) throw new Error(`Could not save chat message: ${error.message}`);
}

async function replyToPatient(phone: string, content: string): Promise<string> {
  const messageId = await sendWhatsAppText(phone, content);
  await persistMessage(phone, 'assistant', content);
  return messageId;
}

async function notifyAdmin(
  patientPhone: string,
  patientName: string | null,
  patientMessage: string
): Promise<void> {
  const adminPhone = process.env.ADMIN_PHONE_NUMBER;
  if (!adminPhone) return;

  const label = patientName ? `${patientName} (${patientPhone})` : patientPhone;
  const notification = `🩺 *Mensaje de ${label}:*\n"${patientMessage}"\n\n_Desliza este mensaje para responderle o escribe "cerrar" para devolverlo a la IA._`;
  const adminMessageId = await sendWhatsAppText(adminPhone, notification);

  const { error } = await supabase.from('escalation_mappings').upsert({
    wa_message_id: adminMessageId,
    patient_phone: patientPhone,
  });
  if (error) throw new Error(`Could not save escalation mapping: ${error.message}`);
}

export async function handlePatientMessage(message: IncomingMessage): Promise<void> {
  const { error: patientError } = await supabase
    .from('patients')
    .upsert({ phone: message.from }, { onConflict: 'phone', ignoreDuplicates: true });
  if (patientError) throw new Error(`Could not create patient: ${patientError.message}`);

  const { data: patient, error: lookupError } = await supabase
    .from('patients')
    .select('chat_mode, full_name')
    .eq('phone', message.from)
    .single();
  if (lookupError) throw new Error(`Could not load patient: ${lookupError.message}`);

  if (patient.chat_mode === 'WAITING_HUMAN') {
    await persistMessage(message.from, 'user', message.content);
    await notifyAdmin(message.from, patient.full_name, message.content);
    return;
  }

  if (EMERGENCY_WORDS.test(message.content)) {
    await persistMessage(message.from, 'user', message.content);
    await replyToPatient(message.from, 'Si presentas una emergencia, llama al servicio local de emergencias o acude a urgencias de inmediato. Este chat no sustituye atención médica de emergencia.');
    return;
  }

  if (HUMAN_REQUEST.test(message.content)) {
    await persistMessage(message.from, 'user', message.content);
    await supabase.from('patients').update({ chat_mode: 'WAITING_HUMAN' }).eq('phone', message.from);
    await replyToPatient(message.from, 'He avisado al doctor de la clínica. Escríbeme aquí tu duda y te responderá por este mismo medio lo antes posible.');
    await notifyAdmin(message.from, patient.full_name, message.content);
    return;
  }

  await runPatientAgent(message);
}

export async function handleAdminMessage(message: IncomingMessage): Promise<void> {
  if (message.contextMessageId) {
    const { data: mapping, error: mappingError } = await supabase
      .from('escalation_mappings')
      .select('patient_phone')
      .eq('wa_message_id', message.contextMessageId)
      .maybeSingle();

    if (mappingError) throw new Error(`Could not load escalation mapping: ${mappingError.message}`);

    if (mapping) {
      const text = message.content.trim().toLowerCase();

      if (text === 'cerrar' || text === 'listo') {
        await supabase.from('patients').update({ chat_mode: 'AI_ACTIVE' }).eq('phone', mapping.patient_phone);
        await sendWhatsAppText(message.from, '✅ Chat cerrado. La IA ha retomado el control de este paciente.');
        await sendWhatsAppText(mapping.patient_phone, 'El doctor ha finalizado la consulta directa. El asistente virtual está de nuevo a tu disposición.');
        return;
      }

      await sendWhatsAppText(mapping.patient_phone, message.content);
      await persistMessage(mapping.patient_phone, 'doctor', message.content);
      await sendWhatsAppText(message.from, '✅ Enviado al paciente.');
      return;
    }
  }

  await runAdminAgent(message);
}