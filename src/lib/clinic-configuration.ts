import { supabaseAdmin as db } from '@/lib/supabase';

export const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export type WeeklyHours = { weekday: number; opens_at: string | null; closes_at: string | null }[];

export async function clinicIdentity() {
  const { data } = await db.from('bot_settings').select('clinic_name,bot_name').eq('id', 1).maybeSingle().throwOnError();
  return {
    clinic: data?.clinic_name?.trim() || process.env.CLINIC_NAME || 'J R Dental',
    bot: data?.bot_name?.trim() || process.env.CLINIC_BOT_NAME || 'Benson',
  };
}

export async function weeklyHours(): Promise<WeeklyHours> {
  const { data } = await db.from('clinic_weekly_hours').select('weekday,opens_at,closes_at').order('weekday').throwOnError();
  if (!data || data.length !== 7) throw new Error('Horario semanal incompleto');
  return data;
}

export function parseBusinessHours(value: string) {
  if (/^cerrado$/i.test(value.trim())) return { opens_at: null, closes_at: null };
  const parts = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)\s*[-–]\s*([01]\d|2[0-3]):([0-5]\d)$/);
  if (!parts) return null;
  const opens_at = `${parts[1]}:${parts[2]}`;
  const closes_at = `${parts[3]}:${parts[4]}`;
  return opens_at < closes_at ? { opens_at, closes_at } : null;
}
