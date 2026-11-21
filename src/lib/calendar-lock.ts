import { supabaseAdmin as db } from '@/lib/supabase';

export async function withCalendarLock<T>(id: string, change: () => Promise<T>) {
  const now = new Date();
  const lock = { id: 1, holder: id, expires_at: new Date(now.getTime() + 120_000).toISOString() };
  const { error } = await db.from('calendar_booking_lock').insert(lock);
  if (error?.code === '23505') {
    const { data } = await db.from('calendar_booking_lock').update(lock).eq('id', 1)
      .lt('expires_at', now.toISOString()).select('id').maybeSingle().throwOnError();
    if (!data) return { state: 'busy' } as const;
  } else if (error) {
    throw error;
  }

  try {
    return await change();
  } finally {
    const { error: releaseError } = await db.from('calendar_booking_lock').delete().eq('id', 1).eq('holder', id);
    if (releaseError) console.error('Could not release booking lock');
  }
}
