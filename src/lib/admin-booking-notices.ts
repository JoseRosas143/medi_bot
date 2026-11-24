import { supabaseAdmin as db } from '@/lib/supabase';
import { getCalendarAppointment } from '@/lib/calendar';
import { clinicDate, clinicName, formatAppointment } from '@/lib/clinic-time';
import { hasWhatsAppWindow, isWhatsAppPhone, phoneDigits, sendWhatsAppTemplate, sendWhatsAppText, WhatsAppError } from '@/lib/whatsapp';

const notices = () => db.from('appointment_notices');
const kind = 'booking_admin';
type Destination = { phone: string; inWindow: boolean; template: string | undefined };

async function destination(): Promise<Destination | null> {
  const phone = phoneDigits(process.env.ADMIN_PHONE_NUMBER);
  if (!isWhatsAppPhone(phone)) return null;
  const { data } = await db.from('bot_settings').select('admin_last_inbound_at,admin_booking_template').eq('id', 1).maybeSingle().throwOnError();
  const inWindow = hasWhatsAppWindow(data?.admin_last_inbound_at);
  const template = process.env.WHATSAPP_ADMIN_BOOKING_TEMPLATE?.trim() || data?.admin_booking_template?.trim();
  return inWindow || template ? { phone, inWindow, template } : null;
}

export async function queueAdminBookingNotice(eventId: string, start: string) {
  const key = { event_id: eventId, scheduled_start: start, kind };
  await notices().upsert({ ...key, state: 'queued' }, {
    onConflict: 'event_id,scheduled_start,kind', ignoreDuplicates: true,
  }).throwOnError();
}

async function dispatch(eventId: string, start: string, actualStart: string, target: Destination) {
  const key = { event_id: eventId, scheduled_start: start, kind };
  const { data } = await notices().update({ state: 'sending', updated_at: new Date().toISOString() })
    .match(key).eq('state', 'queued').select('event_id').maybeSingle().throwOnError();
  if (!data) return;

  const when = formatAppointment(actualStart);
  const priority = clinicDate(new Date(actualStart)) === clinicDate() ? 'Para hoy' : 'Programada';
  const sendTemplate = async () => sendWhatsAppTemplate(target.phone, target.template!, [await clinicName(), when, priority]);
  let id: string;
  try {
    if (target.inWindow) {
      try {
        id = await sendWhatsAppText(target.phone, `🗓️ *Nueva cita · ${priority}*\n${when}\nConsulta los datos en la agenda de recepción.`);
      } catch (error) {
        if (!(error instanceof WhatsAppError) || error.code !== 131047 || !target.template) throw error;
        id = await sendTemplate();
      }
    } else id = await sendTemplate();
  } catch (error) {
    const state = error instanceof WhatsAppError && error.code === 131047 && !target.template ? 'queued'
      : error instanceof WhatsAppError && error.status < 500 ? 'rejected' : 'uncertain';
    await notices().update({ state, updated_at: new Date().toISOString() }).match(key).throwOnError();
    return;
  }
  await notices().update({ state: 'accepted', wa_message_id: id, updated_at: new Date().toISOString() }).match(key).throwOnError();
}

export async function dispatchAdminBookingNotice(eventId: string, start: string) {
  const target = await destination();
  if (target) await dispatch(eventId, start, start, target);
}

export async function runAdminBookingNotices() {
  const now = new Date().toISOString();
  await notices().update({ state: 'failed', updated_at: now }).eq('kind', kind).eq('state', 'queued')
    .lte('scheduled_start', now).throwOnError();
  const target = await destination();
  if (!target) return;
  const { data } = await notices().select('event_id,scheduled_start').eq('kind', kind).eq('state', 'queued')
    .gt('scheduled_start', now).order('updated_at').limit(3).throwOnError();
  await Promise.all((data ?? []).map(async row => {
    const event = await getCalendarAppointment(row.event_id);
    if (event && Date.parse(event.start) > Date.now()) await dispatch(row.event_id, row.scheduled_start, event.start, target);
    else await notices().update({ state: 'failed', updated_at: new Date().toISOString() })
      .match({ event_id: row.event_id, scheduled_start: row.scheduled_start, kind, state: 'queued' }).throwOnError();
  }));
}
