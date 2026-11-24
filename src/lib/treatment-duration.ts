import { supabaseAdmin as db } from '@/lib/supabase';

export const DEFAULT_APPOINTMENT_MINUTES = 45;

export function parseTreatmentDuration(value: string) {
  const text = value.trim();
  if (!/^\d{2,3}$/.test(text)) return null;
  const minutes = Number(text);
  return minutes >= 15 && minutes <= 480 ? minutes : null;
}

export type SchedulableTreatment = { id: number; name: string; duration_minutes: number };
const columns = 'id,name,duration_minutes';

export async function getSchedulableTreatment(id: number): Promise<SchedulableTreatment | null> {
  const { data } = await db.from('treatments').select(columns).eq('id', id).eq('is_active', true).maybeSingle().throwOnError();
  return data;
}

export async function matchSchedulableTreatment(name: string): Promise<SchedulableTreatment | null> {
  if (!name || /[%*_\\]/.test(name)) return null;
  const { data } = await db.from('treatments').select(columns).eq('is_active', true).ilike('name', name).limit(2).throwOnError();
  return data?.length === 1 ? data[0] : null;
}
