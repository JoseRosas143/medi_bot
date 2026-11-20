import { supabaseAdmin as db } from '@/lib/supabase';
import { appointmentPatientName, type CalendarEventData } from '@/lib/calendar';
import { clinicName, formatAppointment } from '@/lib/clinic-time';
import { recordTaskReminderStatus } from '@/lib/clinic-tasks';
import { normalized } from '@/lib/menus';
import { comparableWhatsApp, isWhatsAppPhone, phoneDigits, sendWhatsAppTemplate, WhatsAppError } from '@/lib/whatsapp';

export function isPatientNoticeDestination(phone: string) {
  return isWhatsAppPhone(phone) &&
    comparableWhatsApp(phone) !== comparableWhatsApp(phoneDigits(process.env.ADMIN_PHONE_NUMBER));
}

export async function hasVerifiedCancellationContact(appointment: CalendarEventData) {
  const phone = appointment.patientPhone;
  if (!isPatientNoticeDestination(phone)) return false;
  const { data } = await db.from('patients').select('full_name').eq('phone', phone).maybeSingle().throwOnError();
  if (!data?.full_name) return false;
  const comparableName = (value: string) => normalized(value).replace(/\s+/g, ' ');
  return comparableName(data.full_name) === comparableName(appointmentPatientName(appointment.summary));
}

export async function sendAppointmentNotice(appointment: CalendarEventData, kind: 'reminder' | 'cancellation', adminConfirmedPhone?: string) {
  if (!appointment.patientPhone) return 'no_contact';
  if (kind === 'cancellation') {
    const verified = adminConfirmedPhone === undefined
      ? await hasVerifiedCancellationContact(appointment)
      : adminConfirmedPhone === appointment.patientPhone && isPatientNoticeDestination(adminConfirmedPhone);
    if (!verified) return 'unverified_contact';
  }
  const name = kind === 'reminder'
    ? process.env.WHATSAPP_REMINDER_TEMPLATE
    : process.env.WHATSAPP_CANCELLATION_TEMPLATE;
  if (!name) return 'not_configured';
  const key = { event_id: appointment.eventId, scheduled_start: appointment.start, kind };
  const { error } = await db.from('appointment_notices').insert(key);
  if (error?.code === '23505') return 'already_recorded';
  if (error) throw error;

  try {
    const id = await sendWhatsAppTemplate(appointment.patientPhone, name, [
      appointmentPatientName(appointment.summary), clinicName(), formatAppointment(appointment.start),
    ]);
    await db.from('appointment_notices').update({
      state: 'accepted', wa_message_id: id, updated_at: new Date().toISOString(),
    }).match(key).throwOnError();
    return 'accepted';
  } catch (error) {
    const state = error instanceof WhatsAppError && error.status < 500 ? 'rejected' : 'uncertain';
    console.error('Appointment notice failed', { kind, state, code: error instanceof WhatsAppError ? error.code : undefined });
    await db.from('appointment_notices').update({ state, updated_at: new Date().toISOString() }).match(key).throwOnError();
    return state;
  }
}

export async function recordNoticeStatus(id: string, status: string) {
  if (status !== 'failed' && status !== 'delivered' && status !== 'read') return;
  const { data } = await db.from('appointment_notices').update({
    state: status === 'failed' ? 'failed' : 'delivered', updated_at: new Date().toISOString(),
  }).eq('wa_message_id', id).in('state', ['accepted', 'uncertain']).select('event_id').maybeSingle().throwOnError();
  if (!data) await recordTaskReminderStatus(id, status);
}
