import { supabaseAdmin as db } from '@/lib/supabase';
import { cancelCalendarEvent, createCalendarAppointment, type CalendarEventData } from '@/lib/calendar';
import { formatAppointment } from '@/lib/clinic-time';
import { sendAppointmentNotice } from '@/lib/appointment-notices';
import { sendWhatsAppInteractiveButtons, sendWhatsAppText } from '@/lib/whatsapp';

type Booking = { startTime: string; patientName: string; isUrgent?: boolean };
type Action =
  | { action: 'book'; details: Booking }
  | { action: 'cancel_patient' | 'cancel_clinic'; details: CalendarEventData };

export async function proposeAppointmentAction(phone: string, action: Action) {
  const { data } = await db.from('pending_appointment_actions').insert({
    actor_phone: phone, ...action,
  }).select('id').single().throwOnError();
  const id = data!.id;
  const booking = action.action === 'book';
  const label = booking
    ? formatAppointment(action.details.startTime)
    : `${action.details.summary}\n${formatAppointment(action.details.start)}`;
  await sendWhatsAppInteractiveButtons({
    to: phone,
    bodyText: `*${booking ? 'Confirmar reserva' : 'Confirmar cancelación'}*\n${label}\n\nEsta opción vence en 15 minutos.`,
    buttons: [
      { id: `appointment_yes_${id}`, title: booking ? 'Confirmar cita' : 'Sí, cancelar cita' },
      { id: `appointment_no_${id}`, title: 'Volver' },
    ],
  });
}

async function bookWithLock(id: string, phone: string, booking: Booking) {
  const now = new Date();
  const lock = { id: 1, holder: id, expires_at: new Date(now.getTime() + 120_000).toISOString() };
  const { error } = await db.from('calendar_booking_lock').insert(lock);
  if (error?.code === '23505') {
    const { data } = await db.from('calendar_booking_lock').update(lock).eq('id', 1)
      .lt('expires_at', now.toISOString()).select('id').maybeSingle().throwOnError();
    if (!data) return 'La agenda se está actualizando. Vuelve a solicitar el horario en un momento.';
  } else if (error) {
    throw error;
  }

  try {
    const slot = await createCalendarAppointment({ actionId: id, patientPhone: phone, ...booking });
    return slot ? `✅ *Cita confirmada*\n${slot.label}` : 'Ese horario ya no está disponible. Pídeme consultar otros horarios.';
  } finally {
    const { error: releaseError } = await db.from('calendar_booking_lock').delete().eq('id', 1).eq('holder', id);
    if (releaseError) console.error('Could not release booking lock');
  }
}

export async function handleAppointmentAction(phone: string, optionId: string | undefined, isAdmin: boolean) {
  const match = optionId?.match(/^appointment_(yes|no)_([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i);
  if (!match) return false;

  const now = new Date().toISOString();
  const { data } = await db.from('pending_appointment_actions').update({ handled_at: now })
    .eq('id', match[2]).eq('actor_phone', phone).is('handled_at', null).gt('expires_at', now)
    .in('action', isAdmin ? ['cancel_clinic'] : ['book', 'cancel_patient'])
    .select('id,action,details').maybeSingle().throwOnError();
  if (!data) {
    await sendWhatsAppText(phone, 'Esta opción ya se usó o venció. Puedes iniciar la solicitud de nuevo.');
    return true;
  }
  if (match[1] === 'no') {
    await sendWhatsAppText(phone, 'De acuerdo. La agenda sigue igual.');
    return true;
  }

  let reply = '';
  const action = data as Action;
  if (action.action === 'book') {
    reply = await bookWithLock(data.id, phone, action.details);
  } else {
    const cancelled = await cancelCalendarEvent(action.details, isAdmin ? undefined : phone);
    if (!cancelled) {
      reply = 'La cita cambió o ya pasó. Consulta la agenda para ver su estado.';
    } else {
      reply = `✅ *Cita cancelada*\n${formatAppointment(cancelled.start)}`;
      if (isAdmin) {
        const notice = await sendAppointmentNotice(cancelled, 'cancellation').catch(() => 'uncertain');
        reply += notice === 'accepted' ? '\nWhatsApp aceptó el aviso al paciente.'
          : notice === 'no_contact' ? '\nEl evento no tiene un teléfono de WhatsApp asociado.'
          : '\nNo se confirmó el envío del aviso al paciente.';
      }
    }
  }
  await sendWhatsAppText(phone, reply);
  return true;
}
