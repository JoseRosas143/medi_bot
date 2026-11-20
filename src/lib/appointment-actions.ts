import { supabaseAdmin as db } from '@/lib/supabase';
import { cancelCalendarEvent, createCalendarAppointment, type CalendarEventData } from '@/lib/calendar';
import { formatAppointment } from '@/lib/clinic-time';
import { hasVerifiedCancellationContact, sendAppointmentNotice } from '@/lib/appointment-notices';
import { sendWhatsAppInteractiveButtons, sendWhatsAppText } from '@/lib/whatsapp';

type Cancellation = { action: 'cancel_patient' | 'cancel_clinic'; details: CalendarEventData & { noticeAllowed?: boolean } };

export async function proposeAppointmentAction(phone: string, action: Cancellation) {
  const clinic = action.action === 'cancel_clinic';
  const canNotify = clinic && await hasVerifiedCancellationContact(action.details).catch(() => false);
  const { data } = await db.from('pending_appointment_actions').insert({
    actor_phone: phone,
    action: action.action,
    details: { ...action.details, noticeAllowed: canNotify },
  }).select('id').single().throwOnError();
  const id = data!.id;
  const label = `${action.details.summary}\n${formatAppointment(action.details.start)}`;
  const ending = action.details.patientPhone ? ` •••• ${action.details.patientPhone.slice(-4)}` : '';
  const contact = canNotify ? `\nWhatsApp del aviso${ending}`
    : clinic ? `\nWhatsApp${ending} sin verificar. Puedes cancelar desde aquí y gestionar el aviso aparte.` : '';
  await sendWhatsAppInteractiveButtons({
    to: phone,
    bodyText: `*Confirmar cancelación*\n${label}${contact}\n\nEsta opción vence en 15 minutos.`,
    buttons: [
      ...(canNotify ? [{ id: `appointment_notify_${id}`, title: 'Cancelar y avisar' }] : []),
      clinic ? { id: `appointment_only_${id}`, title: 'Solo cancelar' }
        : { id: `appointment_yes_${id}`, title: 'Sí, cancelar cita' },
      { id: `appointment_no_${id}`, title: 'Volver' },
    ],
  });
}

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

export function bookWithLock(booking: Parameters<typeof createCalendarAppointment>[0]) {
  return withCalendarLock(booking.actionId, async () => {
    const slot = await createCalendarAppointment(booking);
    return slot ? { state: 'confirmed', label: slot.label } as const : { state: 'unavailable' } as const;
  });
}

export async function handleAppointmentAction(phone: string, optionId: string | undefined, isAdmin: boolean) {
  const match = optionId?.match(/^appointment_(yes|notify|only|no)_([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/);
  if (!match) return false;
  const [, choice, id] = match;
  if (isAdmin ? choice === 'yes' : choice === 'notify' || choice === 'only') {
    await sendWhatsAppText(phone, 'Esa opción cambió. Busca la cita de nuevo para confirmar la cancelación.');
    return true;
  }

  const now = new Date().toISOString();
  const { data } = await db.from('pending_appointment_actions').update({ handled_at: now })
    .eq('id', id).eq('actor_phone', phone).is('handled_at', null).gt('expires_at', now)
    .eq('action', isAdmin ? 'cancel_clinic' : 'cancel_patient')
    .select('id,action,details').maybeSingle().throwOnError();
  if (!data) {
    await sendWhatsAppText(phone, 'Esta opción ya se usó o venció. Puedes iniciar la solicitud de nuevo.');
    return true;
  }
  if (choice === 'no') {
    await sendWhatsAppText(phone, 'De acuerdo. La agenda sigue igual.');
    return true;
  }

  let reply = '';
  const action = data as Cancellation;
  if (choice === 'notify' && !action.details.noticeAllowed) {
    await sendWhatsAppText(phone, 'El WhatsApp no se verificó. Busca la cita de nuevo y elige cómo cancelarla.');
    return true;
  }
  const cancelled = await cancelCalendarEvent(action.details, isAdmin ? undefined : phone);
  if (!cancelled) {
    reply = 'La cita cambió o ya pasó. Consulta la agenda para ver su estado.';
  } else {
    reply = `✅ *Cita cancelada*\n${formatAppointment(cancelled.start)}`;
    if (choice === 'notify') {
      const notice = await sendAppointmentNotice(cancelled, 'cancellation').catch(() => 'uncertain');
      reply += notice === 'accepted' ? '\nWhatsApp aceptó el aviso al paciente.'
        : notice === 'no_contact' ? '\nEl evento no tiene un teléfono de WhatsApp asociado.'
        : notice === 'unverified_contact' ? '\nEl WhatsApp ya no coincide con la ficha del paciente. El aviso no se envió.'
        : '\nNo se confirmó el envío del aviso al paciente.';
    } else if (choice === 'only') {
      reply += '\nSe canceló sin enviar aviso por WhatsApp.';
    }
  }
  await sendWhatsAppText(phone, reply);
  return true;
}
