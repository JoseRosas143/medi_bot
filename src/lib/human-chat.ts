import { randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase';

export type HumanPatient = { phone: string; full_name: string | null; chat_mode: string; human_session_id: string | null };

export async function openHumanChat(phone: string) {
  const sessionId = randomUUID();
  const { data } = await db.from('patients').update({ chat_mode: 'WAITING_HUMAN', human_session_id: sessionId })
    .eq('phone', phone).eq('chat_mode', 'AI_ACTIVE').select('phone').maybeSingle().throwOnError();
  return data ? sessionId : null;
}

export async function closeHumanChat(patient: Pick<HumanPatient, 'phone' | 'human_session_id'>) {
  let update = db.from('patients').update({ chat_mode: 'AI_ACTIVE', human_session_id: null })
    .eq('phone', patient.phone).eq('chat_mode', 'WAITING_HUMAN');
  update = patient.human_session_id ? update.eq('human_session_id', patient.human_session_id) : update.is('human_session_id', null);
  const { data } = await update.select('phone').maybeSingle().throwOnError();
  return !!data;
}

export async function trackHumanChatReply(messageId: string, patient: Pick<HumanPatient, 'phone' | 'human_session_id'>) {
  await db.from('escalation_mappings').insert({
    wa_message_id: messageId, patient_phone: patient.phone, human_session_id: patient.human_session_id,
  }).throwOnError();
}

export async function recordChatMessage(phone: string, role: 'user' | 'assistant' | 'doctor', content: string) {
  await db.from('chat_messages').insert({ patient_phone: phone, role, content }).throwOnError();
}
