import { supabaseAdmin as db } from '@/lib/supabase';

export type WaitlistOfferStatus = 'sending' | 'sent' | 'unknown' | 'send_error' |
  'accepted' | 'declined' | 'expired' | 'withdrawn' | 'unavailable';

export const waitlistOfferHistory = () => db.from('waitlist_offer_history');

export async function logWaitlistOffer(offer: {
  offer_id: string; request_id: string; phone: string; start_at: string; deadline: string | null;
}) {
  const { error } = await waitlistOfferHistory().insert({ ...offer, status: 'sending' });
  if (error) console.error('Waitlist offer history insert failed', { code: error.code });
}

export async function updateLoggedOffer(offerId: string, status: WaitlistOfferStatus, onlyWhileSending = false) {
  const update = waitlistOfferHistory().update({ status }).eq('offer_id', offerId);
  const { error } = await (onlyWhileSending ? update.eq('status', 'sending') : update);
  if (error) console.error('Waitlist offer history update failed', { code: error.code });
}
