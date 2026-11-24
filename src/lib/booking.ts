import { randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase';
import { bookWithLock } from '@/lib/appointment-actions';
import { dispatchAdminBookingNotice, queueAdminBookingNotice } from '@/lib/admin-booking-notices';
import { withCalendarLock } from '@/lib/calendar-lock';
import { appointmentMatchesSlot, findCalendarBooking, getAvailableSlots, getCalendarAppointment, getUpcomingSlots, moveCalendarAppointment, type CalendarEventData } from '@/lib/calendar';
import { CLINIC_TIMEZONE, clinicDate, clinicInstant, formatAppointment, nextDate } from '@/lib/clinic-time';
import { formatVisitLocation } from '@/lib/clinic-visit';
import { DEFAULT_APPOINTMENT_MINUTES, getSchedulableTreatment, matchSchedulableTreatment } from '@/lib/treatment-duration';
import { offerReleasedAppointment } from '@/lib/waitlist';
import { normalized, showList } from '@/lib/menus';
import { askReminderPreference } from '@/lib/reminder-preference';
import { isWhatsAppPhone, phoneDigits, sendWhatsAppInteractiveButtons, sendWhatsAppText } from '@/lib/whatsapp';

type Slot = Awaited<ReturnType<typeof getUpcomingSlots>>[number];
type Details = {
  options?: Slot[];
  selected?: Slot;
  patientName?: string;
  patientPhone?: string;
  reason?: string;
  original?: CalendarEventData;
  awaitingDate?: boolean;
  treatmentId?: number;
  durationMinutes?: number;
  reselectOnly?: boolean;
};
type Stage = 'search' | 'options' | 'name' | 'contact' | 'reason' | 'confirm' | 'processing' | 'confirmed';
type Draft = { actor_phone: string; id: string; revision: string; stage: Stage; details: Details; expires_at: string };
type Preference = { date: string; time?: string; alternative?: string };

const drafts = () => db.from('booking_drafts');
const expiry = (minutes = 15) => new Date(Date.now() + minutes * 60_000).toISOString();
const current = (draft: Draft) => Date.parse(draft.expires_at) > Date.now();
const buttonId = (draft: Draft, action: string) => `booking_${draft.revision}_${action}`;
const stale = (phone: string) => sendWhatsAppText(phone, 'Esa opción ya cambió o venció. Usa el mensaje más reciente o elige «Agendar cita».');

async function readDraft(phone: string): Promise<Draft | null> {
  const { data } = await drafts().select('*').eq('actor_phone', phone).maybeSingle().throwOnError();
  return data as Draft | null;
}

async function replaceDraft(previous: Draft, stage: Stage, details: Details, id = previous.id) {
  let update = drafts().update({ id, stage, details, revision: randomUUID(), expires_at: expiry(stage === 'processing' ? 2 : 15) })
    .eq('actor_phone', previous.actor_phone).eq('revision', previous.revision);
  if (stage === 'processing') update = update.gt('expires_at', new Date().toISOString());
  const { data } = await update.select('*').maybeSingle().throwOnError();
  return data as Draft | null;
}

export function chooseSlots(slots: Slot[], preferred?: string) {
  const first = slots.find(slot => slot.start === preferred) || slots[0];
  if (!first) return [];
  const second = slots.find(slot => Date.parse(slot.start) >= Date.parse(first.end))
    || [...slots].reverse().find(slot => Date.parse(slot.end) <= Date.parse(first.start));
  return second ? [first, second] : [first];
}

const shortSlot = new Intl.DateTimeFormat('es-MX', {
  timeZone: CLINIC_TIMEZONE, weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const localTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: CLINIC_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const slotRange = new Intl.DateTimeFormat('es-MX', {
  timeZone: CLINIC_TIMEZONE, dateStyle: 'full', timeStyle: 'short', hourCycle: 'h23',
});

function formatSlot(slot: Slot) {
  return slotRange.formatRange(new Date(slot.start), new Date(slot.end));
}

function requestedSchedule(text: string, tentativeDate: string, requireDate = false): Preference | null {
  const standard = normalized(text).replace(/[¿?]/g, '');
  const numericDate = standard.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const explicitDate = standard.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ??
    (numericDate ? `${numericDate[3]}-${numericDate[2].padStart(2, '0')}-${numericDate[1].padStart(2, '0')}` : undefined);
  const weekdays = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const namedDay = standard.match(/\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/)?.[0];
  const today = clinicDate();
  let day = explicitDate ?? (/\bmanana\b/.test(standard) ? nextDate(today) : /\bhoy\b/.test(standard) ? today : undefined);
  if (!day && namedDay) {
    day = today;
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const offset = (weekdays.indexOf(namedDay) - weekday + 7) % 7;
    const days = offset || (/\bproximo\b/.test(standard) ? 7 : 0);
    for (let index = 0; index < days; index++) day = nextDate(day);
  }
  if (day) {
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null;
  }
  if (requireDate && !day) return null;
  // Prefer the explicit hour after “a las” or a full HH:MM over numbers in dates.
  const timeMatch = standard.match(/\ba (?:la|las)\s+(\d{1,2})(?::([0-5]\d))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?\b/)
    || standard.match(/\b(\d{1,2}):([0-5]\d)\s*(a\.?\s*m\.?|p\.?\s*m\.?)?\b/)
    || standard.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)\b/);
  if (!timeMatch) return day ? { date: day } : null;
  let hour = Number(timeMatch[1]);
  const meridiem = timeMatch[3]?.[0];
  if (hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem) hour = hour % 12 + (meridiem === 'p' ? 12 : 0);
  const time = `${String(hour).padStart(2, '0')}:${timeMatch[2] || '00'}`;
  return { date: day || tentativeDate, time, ...(meridiem || hour < 1 || hour >= 12 ? {} : {
    alternative: `${String(hour + 12).padStart(2, '0')}:${timeMatch[2] || '00'}`,
  }) };
}

async function offer(draft: Draft, preference?: Preference | null, after?: number) {
  const phone = draft.actor_phone;
  const treatment = draft.details.treatmentId === undefined ? null : await getSchedulableTreatment(draft.details.treatmentId);
  if (draft.details.treatmentId !== undefined && !treatment) {
    return finishUnchanged(draft, 'Ese tratamiento ya no está disponible. Selecciona otro desde el menú.');
  }
  const next = await replaceDraft(draft, 'search', { ...draft.details,
    durationMinutes: treatment?.duration_minutes, options: undefined, selected: undefined, awaitingDate: undefined });
  if (!next) return stale(phone);
  let slots: Slot[];
  let preferred: Slot | undefined;
  let label = '';
  const original = next.details.original;
  const duration = original ? Date.parse(original.end) - Date.parse(original.start) : (next.details.durationMinutes ?? DEFAULT_APPOINTMENT_MINUTES) * 60_000;
  const otherSlots = (slots: Slot[]) => slots.filter(slot => !original || Date.parse(slot.start) !== Date.parse(original.start));
  if (preference) {
    const day = await getAvailableSlots(preference.date, duration);
    slots = otherSlots(day.slots);
    if (preference.time) {
      preferred = slots.find(slot => localTime.format(new Date(slot.start)) === preference.time)
        ?? slots.find(slot => localTime.format(new Date(slot.start)) === preference.alternative);
      if (!preferred) label = 'Ese horario no está disponible. ';
    }
    if (!slots.length) {
      const nextDay = nextDate(preference.date);
      slots = otherSlots(await getUpcomingSlots(clinicInstant(nextDay, '00:00').getTime() - 1, duration));
      label = day.closed ? 'La clínica está cerrada ese día. ' : 'No encontré espacios para ese día. ';
    }
  } else {
    slots = otherSlots(await getUpcomingSlots(after, duration));
  }
  const options = chooseSlots(slots, preferred?.start);
  const updated = await replaceDraft(next, 'options', { ...next.details, options });
  if (!updated) return stale(phone);
  const propose = { id: buttonId(updated, 'date'), title: 'Proponer día' };
  if (!options.length) {
    await sendWhatsAppInteractiveButtons({ to: phone, bodyText: `${label}No encontré horarios cercanos. Puedes indicar otra fecha.`, buttons: [propose] });
    return;
  }
  const body = `🗓️ *Horarios disponibles*\n${original ? `Cita actual: ${formatAppointment(original.start)}\n` : ''}${label}Elige un horario.\n\n${options.map((slot, index) => `${index + 1}. ${formatSlot(slot)}`).join('\n')}`;
  const choices = [
    ...options.map((slot, index) => ({ id: buttonId(updated, String(index)), title: shortSlot.format(new Date(slot.start)) })),
    propose, { id: buttonId(updated, 'more'), title: 'Ver otros horarios' },
  ];
  if (choices.length <= 3) await sendWhatsAppInteractiveButtons({ to: phone, bodyText: body, buttons: choices });
  else await showList(phone, body, 'Ver horarios', [{ title: 'Horarios y opciones', rows: choices }],
    'Puedes escribir «1», «2», «Proponer día» u «Otros horarios».');
}

export async function startBooking(phone: string, isAdmin: boolean, patientName?: string | null, treatment?: string, request?: string, treatmentId?: number) {
  await openDraft(phone, {
    patientPhone: isAdmin ? undefined : phone,
    patientName: isAdmin ? undefined : fullName(patientName || '') || undefined,
    reason: treatment,
    treatmentId,
  }, request);
}

export async function startReschedule(phone: string, original: CalendarEventData, request?: string, isAdmin = false) {
  const duration = Date.parse(original.end) - Date.parse(original.start);
  if (!original.patientPhone || (!isAdmin && original.patientPhone !== phone) || !Number.isFinite(duration) || duration <= 0) {
    await sendWhatsAppText(phone, 'Consulta con recepción para cambiar esta cita.');
    return;
  }
  await openDraft(phone, { patientPhone: original.patientPhone, original }, request);
}

async function openDraft(phone: string, details: Details, request?: string) {
  const previous = await readDraft(phone);
  if (previous?.stage === 'processing') {
    await checkProcessing(previous);
    return;
  }
  const draft = previous
    ? await replaceDraft(previous, 'search', details, randomUUID())
    : await insertDraft(phone, details);
  if (!draft) return stale(phone);
  const referenceDate = details.original ? clinicDate(new Date(details.original.start)) : clinicDate();
  const preference = request ? requestedSchedule(request, referenceDate) : null;
  await offer(draft, preference);
}

async function insertDraft(phone: string, details: Details) {
  const row: Draft = { actor_phone: phone, id: randomUUID(), revision: randomUUID(), stage: 'search', details, expires_at: expiry() };
  const { error } = await drafts().insert(row);
  if (error?.code === '23505') return null;
  if (error) throw error;
  return row;
}

function fullName(text: string) {
  const value = text.replace(/^(?:me llamo|mi nombre es|soy)\s+/i, '').trim().replace(/\s+/g, ' ');
  return value.length <= 90 && value.includes(' ') && /^[\p{L}\p{M}]+(?:[\u2019' -][\p{L}\p{M}]+)+$/u.test(value)
    && !/\b(?:hola|si|cita|horario|agenda|quiero|gracias|nombre|confirmar)\b/.test(normalized(value)) ? value : null;
}

async function askName(draft: Draft) {
  const name = draft.details.patientName;
  if (!name) return sendWhatsAppText(draft.actor_phone, 'Escribe el nombre completo de la persona que asistirá a la cita.');
  return sendWhatsAppInteractiveButtons({
    to: draft.actor_phone,
    bodyText: `*Nombre para la cita*\n${name}\n¿Es el nombre completo de la persona que asistirá? También puedes escribir el nombre correcto.`,
    buttons: [
      { id: buttonId(draft, 'name'), title: 'Usar este nombre' },
      { id: buttonId(draft, 'edit'), title: 'Cambiar nombre' },
    ],
  });
}

async function advance(draft: Draft, details: Details) {
  const stage = !details.patientPhone ? 'contact' : !details.reason ? 'reason' : 'confirm';
  const updated = await replaceDraft(draft, stage, details);
  if (!updated) return stale(draft.actor_phone);
  if (stage === 'contact') return sendWhatsAppText(draft.actor_phone, 'Escribe el WhatsApp del paciente con código de país, por ejemplo +52 seguido de 10 dígitos.');
  if (stage === 'reason') return sendWhatsAppText(draft.actor_phone, '¿Cuál es el motivo de consulta o el tratamiento que se solicita? Escríbelo en una frase breve. Se guardará en las notas de la cita.');
  return showConfirmation(updated);
}

async function showConfirmation(draft: Draft) {
  const { selected, patientName, patientPhone, reason, original } = draft.details;
  if (original && selected) return sendWhatsAppInteractiveButtons({
    to: draft.actor_phone,
    bodyText: `*Confirma el cambio de horario*\nCita actual: ${formatAppointment(original.start)}\nNuevo horario: ${formatSlot(selected)}`,
    buttons: [
      { id: buttonId(draft, 'confirm'), title: 'Confirmar cambio' },
      { id: buttonId(draft, 'more'), title: 'Ver otros horarios' },
      { id: buttonId(draft, 'leave'), title: 'Conservar mi cita' },
    ],
  });
  if (!selected || !patientName || !patientPhone || !reason) return stale(draft.actor_phone);
  return sendWhatsAppInteractiveButtons({
    to: draft.actor_phone,
    bodyText: `*Confirma los datos de la cita*\n🗓️ ${formatSlot(selected)}\n👤 ${patientName}\n📝 ${reason}${patientPhone !== draft.actor_phone ? `\nWhatsApp: +${patientPhone}` : ''}\n\nAl confirmar se guardará el motivo en las notas de Calendar.`,
    buttons: [
      { id: buttonId(draft, 'confirm'), title: 'Confirmar cita' },
      { id: buttonId(draft, 'more'), title: 'Cambiar horario' },
      { id: buttonId(draft, 'edit'), title: 'Corregir datos' },
    ],
  });
}

async function markConfirmed(draft: Draft) {
  const { original, selected, patientPhone } = draft.details;
  if (!selected) return;
  const bookingId = draft.id.replaceAll('-', '');
  const alertAdmin = !original && patientPhone === draft.actor_phone;
  if (alertAdmin) await queueAdminBookingNotice(bookingId, selected.start).catch(() => console.error('Could not queue booking notice'));
  const updated = await replaceDraft(draft, 'confirmed', { selected: draft.details.selected });
  if (!updated) return;
  if (!original && patientPhone && patientPhone !== draft.actor_phone) {
    const { error } = await db.from('patients').upsert({ phone: patientPhone }, { onConflict: 'phone', ignoreDuplicates: true });
    if (error) console.error('Could not register the new appointment contact', { code: error.code });
  }
  const moved = Boolean(original);
  const status = moved ? 'Cita reagendada' : 'Cita confirmada';
  const selfBooking = patientPhone === draft.actor_phone;
  const location = selfBooking ? `\n\n${await formatVisitLocation()}\n\nEn el menú «Mis citas» puedes consultar tu cita, confirmar tu asistencia o cancelarla.` : '';
  try {
    await sendWhatsAppText(draft.actor_phone, `✅ *${status}*\n${formatSlot(selected)}${location}`);
    if (selfBooking && !moved) await askReminderPreference(draft.actor_phone);
  } finally {
    if (alertAdmin) await dispatchAdminBookingNotice(bookingId, selected.start).catch(() => console.error('Could not dispatch booking notice'));
    if (original) await offerReleasedAppointment(original).catch(() => console.error('Could not process released appointment'));
  }
}

async function finishUnchanged(draft: Draft, message: string) {
  const { data } = await drafts().update({ stage: 'options', expires_at: new Date().toISOString(), details: {}, revision: randomUUID() })
    .eq('actor_phone', draft.actor_phone).eq('revision', draft.revision).select('id').maybeSingle().throwOnError();
  if (data) await sendWhatsAppText(draft.actor_phone, message);
}

async function checkProcessing(draft: Draft) {
  const phone = draft.actor_phone;
  if (current(draft)) return sendWhatsAppText(phone, 'La agenda está confirmando tu cita. Espera la respuesta antes de iniciar otra.');
  const original = draft.details.original;
  const event = original ? await getCalendarAppointment(original.eventId) : await findCalendarBooking(draft.id);
  if (appointmentMatchesSlot(event, draft.details.patientPhone, draft.details.selected)) {
    return markConfirmed(draft);
  }
  if (original && (!event || event.patientPhone !== draft.details.patientPhone || Date.parse(event.start) !== Date.parse(original.start))) {
    return finishUnchanged(draft, 'La cita cambió en la agenda. Consulta su estado en «Mis citas».');
  }
  if (!original && event) return sendWhatsAppText(phone, 'Revisa «Mis citas» o consulta con recepción antes de reservar otra.');
  const updated = await replaceDraft(draft, 'confirm', draft.details);
  if (updated) await showConfirmation(updated);
}

async function confirm(draft: Draft) {
  const { selected, patientName, patientPhone, reason, original, treatmentId, durationMinutes } = draft.details;
  if (!selected || !patientPhone) return stale(draft.actor_phone);
  if (!original && (!patientName || !reason)) return stale(draft.actor_phone);
  const lock = await replaceDraft(draft, 'processing', draft.details);
  if (!lock) return stale(draft.actor_phone);
  try {
    const result = original
      ? await withCalendarLock(lock.id, () => moveCalendarAppointment(original, patientPhone, selected.start))
      : await bookWithLock({ actionId: lock.id, patientName: patientName!, patientPhone, reason: reason!, startTime: selected.start,
        treatmentId, durationMinutes });
    if (result.state === 'confirmed') return markConfirmed(lock);
    if (result.state === 'changed') return finishUnchanged(lock, 'La cita cambió en la agenda. Abre «Mis citas» para ver el horario vigente.');
    if (result.state === 'busy') {
      const updated = await replaceDraft(lock, 'confirm', lock.details);
      if (updated) await showConfirmation(updated);
      return;
    }
    await sendWhatsAppText(draft.actor_phone, original
      ? 'Ese horario se ocupó. Tu cita conserva el horario original. Te muestro otras opciones.'
      : 'El horario o la duración cambió antes de confirmar. Te muestro otras opciones.');
    await offer(original ? lock : { ...lock, details: { ...lock.details, reselectOnly: true } });
  } catch {
    // Keep the deterministic Calendar ID and reconcile before offering another reservation.
    await sendWhatsAppText(draft.actor_phone, 'La confirmación quedó pendiente de verificar. Espera dos minutos y vuelve a escribir para revisar el estado.');
  }
}

export async function handleBooking(phone: string, option: string | undefined, content: string): Promise<boolean> {
  const button = option?.match(/^booking_([\da-f-]{36})_(0|1|more|date|name|edit|confirm|leave)$/i);
  if (option && !button) return false;
  const draft = await readDraft(phone);
  if (!draft || (!current(draft) && draft.stage !== 'processing')) {
    if (button) await stale(phone);
    return !!button;
  }
  if (button && draft.revision !== button[1]) {
    await stale(phone);
    return true;
  }
  if (draft.stage === 'processing') {
    await checkProcessing(draft);
    return true;
  }
  const reference = draft.details.selected || draft.details.options?.[0];
  const text = normalized(content);
  const isScheduling = ['options', 'confirm', 'confirmed', 'search'].includes(draft.stage)
    || /^(?:[¿?]*(?:hay|puede|podria|prefiero|mejor|cambia|a las)\b|\d{4}-\d{2}-\d{2})/.test(text);
  const preference = !button && isScheduling
    ? requestedSchedule(content, reference ? clinicDate(new Date(reference.start)) : clinicDate(), draft.details.awaitingDate)
    : null;
  const wantsAnother = button?.[2] === 'more' || /^(?:ver )?(?:otros horarios|cambiar horario|otra hora|otra fecha)$/.test(text);
  if (draft.stage === 'confirmed') {
    if (!preference && !wantsAnother) return false;
    await sendWhatsAppText(phone, `Tu cita ya está confirmada para ${reference?.label}. Puedes verla en «Mis citas» antes de reservar otra.`);
    return true;
  }
  const datePrompt = 'Escribe la fecha que prefieres, por ejemplo «jueves» o «26/11/2026».';
  if (draft.stage === 'options' && (button?.[2] === 'date' || (!button && text === 'proponer dia'))) {
    const updated = await replaceDraft(draft, 'options', { ...draft.details, awaitingDate: true, options: undefined });
    if (updated) await sendWhatsAppText(phone, datePrompt);
    return true;
  }
  if (draft.details.awaitingDate && !wantsAnother && (!preference || preference.date < clinicDate())) {
    await sendWhatsAppText(phone, datePrompt);
    return true;
  }
  if ((preference && draft.stage !== 'contact') || wantsAnother || draft.stage === 'search') {
    const options = draft.stage === 'options' && wantsAnother ? draft.details.options : undefined;
    const after = options?.length ? Math.max(...options.map(slot => Date.parse(slot.start))) : undefined;
    await offer(draft, preference, after);
    return true;
  }
  const action = button?.[2] ?? normalized(content);
  if (draft.stage === 'options') {
    const index = button ? Number(action) : ({ '1': 0, '2': 1, 'opcion 1': 0, 'opcion 2': 1 } as Record<string, number>)[action];
    const slot = draft.details.options?.[index];
    if (!slot) await sendWhatsAppText(phone, 'Toca uno de los horarios disponibles o escribe «otros horarios».');
    else {
      const ready = Boolean(draft.details.original || (draft.details.reselectOnly && draft.details.patientName &&
        draft.details.patientPhone && draft.details.reason));
      const updated = await replaceDraft(draft, ready ? 'confirm' : 'name', { ...draft.details, selected: slot });
      if (updated && ready) await showConfirmation(updated);
      else if (updated) await askName(updated);
    }
  } else if (draft.stage === 'name') {
    const name = action === 'name' ? draft.details.patientName : !button ? fullName(content) : null;
    if (name) await advance(draft, { ...draft.details, patientName: name });
    else if (action === 'edit') {
      const updated = await replaceDraft(draft, 'name', { ...draft.details, patientName: undefined });
      if (updated) await askName(updated);
    } else await askName(draft);
  } else if (draft.stage === 'contact') {
    const digits = phoneDigits(content);
    const contact = /^\d{10}$/.test(digits) ? `52${digits}` : digits;
    if (isWhatsAppPhone(contact)) await advance(draft, { ...draft.details, patientPhone: contact });
    else await sendWhatsAppText(phone, 'Escribe un número válido con código de país.');
  } else if (draft.stage === 'reason') {
    const reason = content.trim().replace(/\s+/g, ' ');
    if (reason.length < 3 || reason.length > 300 || /^(?:si|confirmo|confirmar|listo)$/.test(action)) {
      await sendWhatsAppText(phone, 'Escribe el tratamiento o un motivo breve para la cita, de hasta 300 caracteres.');
    } else {
      const treatment = await matchSchedulableTreatment(reason);
      const details = { ...draft.details, reason, treatmentId: treatment?.id, durationMinutes: treatment?.duration_minutes };
      const selected = draft.details.selected;
      const duration = treatment?.duration_minutes ?? DEFAULT_APPOINTMENT_MINUTES;
      if (selected && Date.parse(selected.end) - Date.parse(selected.start) !== duration * 60_000) {
        await sendWhatsAppText(phone, `La cita necesita ${duration} minutos. Te muestro horarios para esa duración.`);
        await offer({ ...draft, details: { ...details, reselectOnly: true } }, { date: clinicDate(new Date(selected.start)) });
      } else await advance(draft, details);
    }
  } else if (draft.stage === 'confirm') {
    if (button && action === 'confirm') await confirm(draft);
    else if (button && action === 'leave' && draft.details.original) await finishUnchanged(draft, 'Tu cita conserva el horario original.');
    else if (button && action === 'edit') {
      const updated = await replaceDraft(draft, 'name', { ...draft.details, patientName: undefined, reason: undefined });
      if (updated) await askName(updated);
    } else await showConfirmation(draft);
  }
  return true;
}
