import { supabaseAdmin as db } from '@/lib/supabase';
import { showPatientMenu } from '@/lib/menus';
import { sendWhatsAppText } from '@/lib/whatsapp';

export function correctedName(input: string) {
  const name = input.trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= 90 &&
    /^[\p{L}\p{M}]+(?:['’ -][\p{L}\p{M}]+)*$/u.test(name) ? name : null;
}

export async function savePatientName(phone: string, name: string) {
  const { data } = await db.from('patients').update({ full_name: name, onboarding_completed: true })
    .eq('phone', phone).select('phone').maybeSingle().throwOnError();
  return Boolean(data);
}

export async function handlePatientNameCorrection(phone: string, option: string | undefined, content: string) {
  const command = !option && content.trim().match(/^corregir mi nombre(?:\s+(?:a\s+)?(.+))?$/i);
  if (option !== 'patient_name_edit' && !command) return false;
  const name = command && command[1] ? correctedName(command[1]) : null;
  if (!name) {
    await sendWhatsAppText(phone, 'Escribe «Corregir mi nombre a» seguido de tu nombre correcto.');
    return true;
  }
  if (await savePatientName(phone, name)) {
    await showPatientMenu(phone, name);
  }
  return true;
}
