import { randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase';
import { appointmentMatchesSlot, getAppointmentsByDateRange, getAvailableSlots, getCalendarAppointment, moveCalendarAppointment, type CalendarEventData } from '@/lib/calendar';
import { withCalendarLock } from '@/lib/calendar-lock';
import { clinicDate, clinicName, formatAppointment } from '@/lib/clinic-time';
import { formatVisitLocation } from '@/lib/clinic-visit';
import { logWaitlistOffer, updateLoggedOffer, type WaitlistOfferStatus } from '@/lib/waitlist-offer-log';
import { hasWhatsAppWindow, sendWhatsAppInteractiveButtons, sendWhatsAppTemplate, sendWhatsAppText, WhatsAppError } from '@/lib/whatsapp';

type Entry = { id: string; event_id: string; phone: string; original_start: string; original_end: string };
type Candidate = Entry & { patients: { last_inbound_at: string | null } };
type Opening = {
  id: string; revision: string; start_at: string; end_at: string; state: 'open' | 'offered' | 'processing' | 'closed';
  attempted_ids: string[]; candidate_id: string | null; candidate_event_id: string | null;
  candidate_phone: string | null; offer_id: string | null; deadline: string | null;
  checked_at: string;
};

const requests = () => db.from('appointment_waitlist');
const openings = () => db.from('waitlist_openings');
const now = () => new Date().toISOString();
const offerWindow = 30 * 60_000;
const entrySlot = (entry: Entry) => ({ start: entry.original_start, end: entry.original_end });
const expiry = (time: number) => new Date(time).toISOString();
const available = (opening: Opening) => Date.parse(opening.start_at) > Date.now();

async function updateOpening(opening: Opening, changes: Partial<Opening>) {
  const result = await openings().update({ ...changes, revision: randomUUID() })
    .eq('id', opening.id).eq('revision', opening.revision).select('*').maybeSingle();
  if (result.error?.code === '23505') return null;
  if (result.error) throw result.error;
  return result.data as Opening | null;
}

async function configuredTemplate() {
  const override = process.env.WHATSAPP_WAITLIST_TEMPLATE?.trim();
  if (override) return override;
  const { data } = await db.from('bot_settings').select('waitlist_template').eq('id', 1).maybeSingle().throwOnError();
  return data?.waitlist_template?.trim() || undefined;
}

async function reopen(opening: Opening, status: WaitlistOfferStatus = 'expired') {
  const next = await updateOpening(opening, {
    state: available(opening) ? 'open' : 'closed',
    candidate_id: null, candidate_event_id: null, candidate_phone: null, offer_id: null, deadline: null,
  });
  if (next && opening.offer_id) await updateLoggedOffer(opening.offer_id, status);
  return next;
}

export async function showWaitlistRequest(phone: string, event: CalendarEventData, code: string) {
  const { data } = await requests().select('*').eq('event_id', event.eventId).eq('phone', phone).maybeSingle().throwOnError();
  const enrolled = data && appointmentMatchesSlot(event, phone, entrySlot(data as Entry));
  await sendWhatsAppInteractiveButtons({
    to: phone, bodyText: `*Lista de espera*\n${formatAppointment(event.start)}\n\n${enrolled
      ? 'Ya pediste adelantar esta cita. Conservas tu horario mientras esperas una oferta.'
      : 'Si se libera una cita más temprano, podemos ofrecértela por orden de solicitud. Tu cita se conserva hasta que aceptes un horario disponible.'}`,
    buttons: [
      enrolled ? { id: `appt_wait_leave_${code}`, title: 'Salir de la lista' }
        : { id: `appt_wait_join_${code}`, title: 'Pedir adelantar' },
      { id: `appt_view_${code}`, title: 'Volver a mi cita' },
    ],
  });
}

export async function changeWaitlistEnrollment(phone: string, event: CalendarEventData, join: boolean) {
  if (event.patientPhone !== phone || Date.parse(event.start) <= Date.now()) return;
  if (join) {
    const { data } = await requests().select('*').eq('event_id', event.eventId).maybeSingle().throwOnError();
    if (!data || !appointmentMatchesSlot(event, phone, entrySlot(data as Entry))) {
      const row = {
        id: randomUUID(), event_id: event.eventId, phone, original_start: event.start, original_end: event.end, requested_at: now(),
      };
      if (!data) {
        const result = await requests().insert(row);
        if (result.error && result.error.code !== '23505') throw result.error;
      } else await requests().update(row).eq('event_id', event.eventId).eq('id', data.id).throwOnError();
    }
  } else {
    await requests().delete().eq('event_id', event.eventId).eq('phone', phone).eq('original_start', event.start).throwOnError();
  }
  await sendWhatsAppText(phone, join
    ? '✅ Aparté tu lugar en la lista de espera. Tu cita sigue en el horario original.'
    : 'Saliste de la lista de espera. Tu cita sigue en el horario original.');
  if (!join) {
    const { data } = await openings().select('*').eq('candidate_phone', phone).eq('candidate_event_id', event.eventId)
      .eq('state', 'offered').maybeSingle().throwOnError();
    if (data) {
      const next = await reopen(data as Opening, 'withdrawn');
      if (next) await dispatchOpening(next);
    }
  }
}

async function sendOffer(opening: Opening, inWindow: boolean, approved?: string) {
  const phone = opening.candidate_phone!;
  const accept = `wait_accept_${opening.offer_id}`;
  const pass = `wait_decline_${opening.offer_id}`;
  const when = formatAppointment(opening.start_at);
  if (inWindow) {
    try {
      await sendWhatsAppInteractiveButtons({ to: phone,
        bodyText: `🗓️ *Se liberó un horario*\n${when}\n\nTu cita conserva el horario original hasta que aceptes y verifiquemos este espacio. Responde antes de 30 minutos o del inicio de la cita.`,
        buttons: [{ id: accept, title: 'Aceptar horario' }, { id: pass, title: 'Conservar mi cita' }],
      });
      return;
    } catch (error) {
      if (!(error instanceof WhatsAppError) || error.code !== 131047 || !approved) throw error;
    }
  }
  if (!approved) throw new Error('Waitlist template is missing');
  await sendWhatsAppTemplate(phone, approved, [clinicName(), when], [accept, pass]);
}

async function dispatchOpening(opening: Opening) {
  if (opening.state !== 'open') return;
  if (!available(opening)) {
    await reopen(opening);
    return;
  }

  const slotLength = Date.parse(opening.end_at) - Date.parse(opening.start_at);
  const approved = await configuredTemplate();
  let query = requests().select('event_id,id,phone,original_start,original_end,patients!inner(last_inbound_at,chat_mode)')
    .gt('original_start', opening.start_at).lte('duration_seconds', Math.floor(slotLength / 1000))
    .eq('patients.chat_mode', 'AI_ACTIVE').order('requested_at').order('id').limit(25);
  if (!approved) query = query.gt('patients.last_inbound_at', expiry(Date.now() - 86_400_000));
  if (opening.attempted_ids.length) query = query.not('id', 'in', `(${opening.attempted_ids.join(',')})`);
  const { data } = await query.throwOnError();
  for (const candidate of (data ?? []) as unknown as Candidate[]) {
    const duration = Date.parse(candidate.original_end) - Date.parse(candidate.original_start);
    if (duration > slotLength) continue;
    const inWindow = hasWhatsAppWindow(candidate.patients.last_inbound_at);
    if (!inWindow && !approved) continue;
    const event = await getCalendarAppointment(candidate.event_id);
    if (!appointmentMatchesSlot(event, candidate.phone, entrySlot(candidate))) {
      await requests().delete().eq('event_id', candidate.event_id).eq('id', candidate.id).throwOnError();
      continue;
    }

    const { slots } = await getAvailableSlots(clinicDate(new Date(opening.start_at)), duration);
    if (!slots.some(slot => Date.parse(slot.start) === Date.parse(opening.start_at))) continue;
    const deadline = Math.min(Date.now() + offerWindow, Date.parse(opening.start_at));
    if (deadline <= Date.now()) return;
    const claimed = await updateOpening(opening, {
      state: 'offered', candidate_id: candidate.id, candidate_event_id: candidate.event_id, candidate_phone: candidate.phone,
      offer_id: randomUUID(), deadline: expiry(deadline), attempted_ids: [...opening.attempted_ids, candidate.id],
    });
    if (!claimed) continue;
    await logWaitlistOffer({
      offer_id: claimed.offer_id!, request_id: candidate.id, phone: candidate.phone,
      start_at: claimed.start_at, deadline: claimed.deadline,
    });
    try {
      await sendOffer(claimed, inWindow, approved);
      await updateLoggedOffer(claimed.offer_id!, 'sent', true);
    } catch (error) {
      // A definitive rejection releases the offer. An ambiguous response keeps it valid until its deadline.
      if (error instanceof WhatsAppError && error.status === 400) await reopen(claimed, 'send_error');
      else await updateLoggedOffer(claimed.offer_id!, 'unknown', true);
      console.error('Waitlist offer not confirmed', { code: error instanceof WhatsAppError ? error.code : undefined });
    }
    return;
  }
  await updateOpening(opening, { checked_at: now() });
}

async function queueOpening(event: CalendarEventData) {
  if (Date.parse(event.start) <= Date.now()) return null;
  const { error, data } = await openings().insert({ source_event_id: event.eventId, start_at: event.start, end_at: event.end })
    .select('*').maybeSingle();
  if (error?.code === '23505') return null;
  if (error) throw error;
  return data as Opening | null;
}

export async function offerReleasedAppointment(event: CalendarEventData) {
  await requests().delete().eq('event_id', event.eventId).eq('original_start', event.start).throwOnError();
  const opening = await queueOpening(event);
  if (opening) await dispatchOpening(opening);
}

async function getCandidate(opening: Opening) {
  const { data } = await requests().select('*').eq('event_id', opening.candidate_event_id)
    .eq('id', opening.candidate_id).eq('phone', opening.candidate_phone).maybeSingle().throwOnError();
  return data as Entry | null;
}

async function completeMove(opening: Opening, entry: Entry) {
  const closed = await updateOpening(opening, { state: 'closed', deadline: null });
  if (!closed) return;
  await updateLoggedOffer(opening.offer_id!, 'accepted');
  await requests().delete().eq('event_id', entry.event_id).eq('id', entry.id).throwOnError();
  const released = await queueOpening({ eventId: entry.event_id, patientPhone: entry.phone, summary: '', ...entrySlot(entry) });
  try {
    await sendWhatsAppText(entry.phone, `✅ *Cita adelantada*\n${formatAppointment(opening.start_at)}\n\n${formatVisitLocation()}`);
  } finally {
    if (released) await dispatchOpening(released);
  }
}

export async function handleWaitlistOffer(phone: string, option: string | undefined) {
  const match = option?.match(/^wait_(accept|decline)_([0-9a-f-]{36})$/);
  if (!match) return false;
  const { data } = await openings().select('*').eq('offer_id', match[2]).eq('candidate_phone', phone)
    .eq('state', 'offered').gt('deadline', now()).gt('start_at', now()).maybeSingle().throwOnError();
  const opening = data as Opening | null;
  if (!opening) {
    await sendWhatsAppText(phone, 'La oferta ya venció o se usó. Consulta «Mis citas» para ver tu horario.');
    return true;
  }
  if (match[1] === 'decline') {
    const next = await reopen(opening, 'declined');
    await sendWhatsAppText(phone, 'Conservas tu cita en el horario actual.');
    if (next) await dispatchOpening(next);
    return true;
  }

  const processing = await updateOpening(opening, { state: 'processing', deadline: expiry(Date.now() + 120_000) });
  if (!processing) {
    await sendWhatsAppText(phone, 'Esa oferta ya está en revisión. Consulta el horario en «Mis citas».');
    return true;
  }
  const entry = await getCandidate(processing);
  const current = entry ? await getCalendarAppointment(entry.event_id) : null;
  if (!entry || !current || !appointmentMatchesSlot(current, phone, entrySlot(entry)) || !available(processing)) {
    const next = await reopen(processing, 'unavailable');
    await sendWhatsAppText(phone, 'La oferta o tu cita cambió. Consulta tu horario en «Mis citas».');
    if (next) await dispatchOpening(next);
    return true;
  }
  const result = await withCalendarLock(processing.id, () => moveCalendarAppointment(current, phone, processing.start_at));
  if (result.state === 'confirmed') await completeMove(processing, entry);
  else if (result.state === 'busy') {
    await updateOpening(processing, { state: 'offered', deadline: opening.deadline });
    await sendWhatsAppText(phone, 'La agenda está ocupada en este momento. Puedes volver a pulsar «Aceptar horario» mientras la oferta siga vigente.');
  } else {
    const next = await reopen(processing, 'unavailable');
    await sendWhatsAppText(phone, 'El espacio ya no está disponible para tu cita. Consulta tu horario en «Mis citas».');
    if (next) await dispatchOpening(next);
  }
  return true;
}

export async function runWaitlist() {
  // Observe Calendar-only changes as well as openings reported immediately by WhatsApp.
  const capturedAt = now();
  await requests().delete().lte('original_start', capturedAt).throwOnError();
  const windowEnd = expiry(Date.parse(capturedAt) + 14 * 86_400_000);
  const events = await getAppointmentsByDateRange(capturedAt, windowEnd);
  await db.rpc('observe_waitlist_calendar', {
    p_captured_at: capturedAt, p_window_end: windowEnd,
    p_appointments: events.filter(event => Date.parse(event.start) > Date.parse(capturedAt) &&
      (event.patientPhone || /^(?:\[URGENTE\]\s*)?Cita:/i.test(event.summary)))
      .map(event => ({ event_id: event.eventId, start_at: event.start, end_at: event.end })),
  }).throwOnError();

  const { data: due } = await openings().select('*').in('state', ['offered', 'processing']).lte('deadline', now())
    .order('deadline').limit(4).throwOnError();
  for (const row of (due ?? []) as Opening[]) {
    if (row.state === 'processing') {
      const entry = await getCandidate(row);
      const event = entry ? await getCalendarAppointment(entry.event_id) : null;
      const duration = entry ? Date.parse(entry.original_end) - Date.parse(entry.original_start) : 0;
      const slot = { start: row.start_at, end: expiry(Date.parse(row.start_at) + duration) };
      if (entry && appointmentMatchesSlot(event, entry.phone, slot)) {
        await completeMove(row, entry);
        continue;
      }
    }
    await reopen(row, row.state === 'processing' ? 'unavailable' : 'expired');
  }
  const { data } = await openings().select('*').eq('state', 'open').order('checked_at').order('start_at').limit(4).throwOnError();
  for (const row of (data ?? []) as Opening[]) await dispatchOpening(row);
}
