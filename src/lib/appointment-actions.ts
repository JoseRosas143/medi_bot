import { supabaseAdmin as db } from '@/lib/supabase';
import { cancelCalendarEvent, createCalendarAppointment, saveCalendarAppointmentContact, type CalendarEventData } from '@/lib/calendar';
import { withCalendarLock } from '@/lib/calendar-lock';
import { formatAppointment } from '@/lib/clinic-time';
import { hasVerifiedCancellationContact, isPatientNoticeDestination, sendAppointmentNotice } from '@/lib/appointment-notices';
import { offerReleasedAppointment } from '@/lib/waitlist';
import { startReschedule } from '@/lib/booking';
import { parseClinicWhatsApp, sendWhatsAppInteractiveButtons, sendWhatsAppInteractiveList, sendWhatsAppText, shorten } from '@/lib/whatsapp';

type Cancellation = {
  action: 'cancel_patient' | 'cancel_clinic';
  details: CalendarEventData & { noticeAllowed?: boolean; contactPromptId?: string; correctedPhone?: string };
};

const pendingActions = () => db.from('pending_appointment_actions');
const actionLabel = (event: CalendarEventData) => `${shorten(event.summary, 160)}\n${formatAppointment(event.start)}`;

async function saveCancellation(phone: string, action: Cancellation) {
  const { data } = await pendingActions().insert({
    actor_phone: phone, action: action.action, details: action.details,
  }).select('id').single().throwOnError();
  return data!.id as string;
}

export async function proposeAppointmentAction(phone: string, action: Cancellation, manage = false) {
  const clinic = action.action === 'cancel_clinic';
  const canNotify = clinic && await hasVerifiedCancellationContact(action.details).catch(() => false);
  const id = await saveCancellation(phone, {
    action: action.action,
    details: { ...action.details, noticeAllowed: canNotify },
  });
  const ending = action.details.patientPhone ? ` •••• ${action.details.patientPhone.slice(-4)}` : '';
  const contact = canNotify ? `\nWhatsApp del aviso${ending}`
    : clinic ? `\nWhatsApp${ending} sin verificar.` : '';
  const title = clinic ? 'Administrar cita' : 'Confirmar cancelación';
  const bodyText = `*${title}*\n${actionLabel(action.details)}${contact}\n\nLas opciones vencen en 15 minutos.`;
  const options = [
    ...(clinic && manage && action.details.patientPhone ? [{ id: `appointment_move_${id}`, title: 'Cambiar horario' }] : []),
    ...(canNotify ? [{ id: `appointment_notify_${id}`, title: 'Cancelar y avisar' }] : []),
    ...(clinic ? [{ id: `appointment_contact_${id}`, title: 'Corregir WhatsApp' }] : []),
    clinic ? { id: `appointment_only_${id}`, title: 'Solo cancelar' }
      : { id: `appointment_yes_${id}`, title: 'Sí, cancelar cita' },
    { id: manage ? 'admin_cancelar' : `appointment_no_${id}`, title: 'Volver' },
  ];
  if (options.length > 3) {
    await sendWhatsAppInteractiveList({
      to: phone, bodyText, buttonText: 'Ver opciones', sections: [{ title: 'Esta cita', rows: options }],
    });
  } else {
    await sendWhatsAppInteractiveButtons({ to: phone, bodyText, buttons: options });
  }
}

async function promptForCorrection(phone: string, action: Cancellation) {
  const contactPromptId = await sendWhatsAppText(phone,
    `*Corregir WhatsApp*\n${actionLabel(action.details)}\n\nResponde a este mensaje con el número correcto del paciente. Escribe 10 dígitos para México o incluye el código de país. Tienes 15 minutos.`);
  await saveCancellation(phone, { ...action, details: { ...action.details, contactPromptId } });
}

export async function handleCancellationContactReply(phone: string, promptId: string, content: string) {
  const now = new Date().toISOString();
  const { data } = await pendingActions().select('id,action,details').eq('actor_phone', phone)
    .eq('action', 'cancel_clinic').eq('details->>contactPromptId', promptId).maybeSingle().throwOnError();
  if (!data) return false;

  const action = data as Cancellation & { id: string };
  const correctedPhone = parseClinicWhatsApp(content);
  if (!correctedPhone || !isPatientNoticeDestination(correctedPhone)) {
    await sendWhatsAppText(phone, 'Responde al mensaje de «Corregir WhatsApp» con un número válido del paciente. El número de recepción no puede recibir este aviso.');
    return true;
  }

  const { data: claimed } = await pendingActions().update({ handled_at: now }).eq('id', action.id)
    .eq('actor_phone', phone).is('handled_at', null).gt('expires_at', now).select('id').maybeSingle().throwOnError();
  if (!claimed) {
    await sendWhatsAppText(phone, 'Esta solicitud ya se usó o venció. Si necesitas corregir el contacto, busca la cita de nuevo.');
    return true;
  }

  const id = await saveCancellation(phone, {
    action: 'cancel_clinic',
    details: { ...action.details, contactPromptId: undefined, correctedPhone },
  });
  await sendWhatsAppInteractiveButtons({
    to: phone,
    bodyText: `*Confirma el WhatsApp del paciente*\n${actionLabel(action.details)}\nNuevo número +${correctedPhone}\n\nPuedes guardar solo el número o usarlo para cancelar la cita y enviar el aviso.`,
    buttons: [
      { id: `appointment_save_${id}`, title: 'Guardar solo número' },
      { id: `appointment_corrected_${id}`, title: 'Cancelar y avisar' },
      { id: `appointment_no_${id}`, title: 'Volver' },
    ],
  });
  return true;
}

export function bookWithLock(booking: Parameters<typeof createCalendarAppointment>[0]) {
  return withCalendarLock(booking.actionId, async () => {
    const slot = await createCalendarAppointment(booking);
    return slot ? { state: 'confirmed', label: slot.label } as const : { state: 'unavailable' } as const;
  });
}

export async function handleAppointmentAction(phone: string, optionId: string | undefined, isAdmin: boolean) {
  const match = optionId?.match(/^appointment_(yes|notify|only|contact|save|corrected|no|move)_([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/);
  if (!match) return false;
  const [, choice, id] = match;
  if (isAdmin ? choice === 'yes' : choice !== 'yes' && choice !== 'no') {
    await sendWhatsAppText(phone, 'Esa opción cambió. Busca la cita de nuevo para ver las acciones disponibles.');
    return true;
  }

  const now = new Date().toISOString();
  const { data } = await pendingActions().update({ handled_at: now })
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
  const { correctedPhone, contactPromptId } = action.details;
  const needsCorrectedPhone = choice === 'save' || choice === 'corrected';
  if (contactPromptId || needsCorrectedPhone !== Boolean(correctedPhone) ||
      (correctedPhone && !isPatientNoticeDestination(correctedPhone))) {
    await sendWhatsAppText(phone, 'Esa opción cambió. Busca la cita de nuevo para ver las acciones disponibles.');
    return true;
  }
  if (choice === 'contact') {
    await promptForCorrection(phone, action);
    return true;
  }
  if (choice === 'move') {
    await startReschedule(phone, action.details, undefined, true);
    return true;
  }
  if (choice === 'save' && correctedPhone) {
    const updated = await saveCalendarAppointmentContact(action.details, correctedPhone);
    await sendWhatsAppText(phone, updated
      ? `✅ *WhatsApp actualizado en Calendar*\n${actionLabel(updated)}\nLa cita sigue programada para ese horario.`
      : 'La cita cambió o ya pasó. Busca la cita de nuevo para actualizar el WhatsApp.');
    return true;
  }
  if (choice === 'notify' && !action.details.noticeAllowed) {
    await sendWhatsAppText(phone, 'El WhatsApp no se verificó. Busca la cita de nuevo y elige cómo cancelarla.');
    return true;
  }
  const cancelled = await cancelCalendarEvent(action.details, isAdmin ? undefined : phone, correctedPhone);
  if (!cancelled) {
    reply = 'La cita cambió o ya pasó. Consulta la agenda para ver su estado.';
  } else {
    reply = `✅ *Cita cancelada*\n${formatAppointment(cancelled.start)}`;
    if (choice === 'notify' || choice === 'corrected') {
      const notice = await sendAppointmentNotice(cancelled, 'cancellation', correctedPhone).catch(() => 'uncertain');
      reply += notice === 'accepted' ? '\nWhatsApp aceptó el aviso al paciente.'
        : notice === 'no_contact' ? '\nEl evento no tiene un teléfono de WhatsApp asociado.'
        : notice === 'unverified_contact' ? '\nEl WhatsApp ya no coincide con la ficha del paciente. El aviso no se envió.'
        : '\nNo se confirmó el envío del aviso al paciente.';
    } else if (choice === 'only') {
      reply += '\nSe canceló sin enviar aviso por WhatsApp.';
    }
  }
  try {
    await sendWhatsAppText(phone, reply);
  } finally {
    if (cancelled) await offerReleasedAppointment(cancelled).catch(() => console.error('Could not process released appointment'));
  }
  return true;
}
