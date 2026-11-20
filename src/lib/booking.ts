import { randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase';
import { bookWithLock } from '@/lib/appointment-actions';
import { findCalendarBooking, getAvailableSlots, getUpcomingSlots } from '@/lib/calendar';
import { CLINIC_TIMEZONE, clinicDate, clinicInstant, nextDate } from '@/lib/clinic-time';
import { normalized } from '@/lib/menus';
import { isWhatsAppPhone, phoneDigits, sendWhatsAppInteractiveButtons, sendWhatsAppText } from '@/lib/whatsapp';

type Slot = Awaited<ReturnType<typeof getUpcomingSlots>>[number];
type Details = {
  options?: Slot[];
  selected?: Slot;
  patientName?: string;
  patientPhone?: string;
  reason?: string;
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

function requestedSchedule(text: string, tentativeDate: string): Preference | null {
  const standard = normalized(text).replace(/[¿?]/g, '');
  const explicitDate = standard.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
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
  const next = await replaceDraft(draft, 'search', { ...draft.details, options: undefined, selected: undefined });
  if (!next) return stale(phone);
  let slots: Slot[];
  let preferred: Slot | undefined;
  let label = '';
  if (preference) {
    const day = await getAvailableSlots(preference.date);
    slots = day.slots;
    if (preference.time) {
      preferred = slots.find(slot => localTime.format(new Date(slot.start)) === preference.time)
        ?? slots.find(slot => localTime.format(new Date(slot.start)) === preference.alternative);
      if (!preferred) label = 'Ese horario no está disponible. ';
    }
    if (!slots.length) {
      const nextDay = nextDate(preference.date);
      slots = await getUpcomingSlots(clinicInstant(nextDay, '00:00').getTime() - 1);
      label = 'No encontré espacios para ese día. ';
    }
  } else {
    slots = await getUpcomingSlots(after);
  }
  const options = chooseSlots(slots, preferred?.start);
  const updated = await replaceDraft(next, 'options', { ...next.details, options });
  if (!updated) return stale(phone);
  if (!options.length) {
    await sendWhatsAppText(phone, 'No encontré horarios en las próximas dos semanas. Puedes indicar otra fecha o hablar con la clínica.');
    return;
  }
  await sendWhatsAppInteractiveButtons({
    to: phone,
    bodyText: `🗓️ *Horarios disponibles*\n${label}Elige un horario.\n\n${options.map((slot, index) => `${index + 1}. ${slot.label}`).join('\n')}`,
    buttons: [
      ...options.map((slot, index) => ({ id: buttonId(updated, String(index)), title: shortSlot.format(new Date(slot.start)) })),
      { id: buttonId(updated, 'more'), title: 'Ver otros horarios' },
    ],
  });
}

export async function startBooking(phone: string, isAdmin: boolean, patientName?: string | null, treatment?: string, request?: string) {
  const previous = await readDraft(phone);
  if (previous?.stage === 'processing') {
    await checkProcessing(previous);
    return;
  }
  const details = {
    patientPhone: isAdmin ? undefined : phone,
    patientName: isAdmin ? undefined : fullName(patientName || '') || undefined,
    reason: treatment,
  };
  const draft = previous
    ? await replaceDraft(previous, 'search', details, randomUUID())
    : await insertDraft(phone, details);
  if (!draft) return stale(phone);
  const preference = request ? requestedSchedule(request, clinicDate()) : null;
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
  const { selected, patientName, patientPhone, reason } = draft.details;
  if (!selected || !patientName || !patientPhone || !reason) return stale(draft.actor_phone);
  return sendWhatsAppInteractiveButtons({
    to: draft.actor_phone,
    bodyText: `*Confirma los datos de la cita*\n🗓️ ${selected.label}\n👤 ${patientName}\n📝 ${reason}${patientPhone !== draft.actor_phone ? `\nWhatsApp: +${patientPhone}` : ''}\n\nAl confirmar se guardará el motivo en las notas de Calendar.`,
    buttons: [
      { id: buttonId(draft, 'confirm'), title: 'Confirmar cita' },
      { id: buttonId(draft, 'more'), title: 'Cambiar horario' },
      { id: buttonId(draft, 'edit'), title: 'Corregir datos' },
    ],
  });
}

async function markConfirmed(draft: Draft) {
  const updated = await replaceDraft(draft, 'confirmed', { selected: draft.details.selected });
  if (updated) await sendWhatsAppText(draft.actor_phone, `✅ *Cita confirmada*\n${draft.details.selected!.label}`);
}

async function checkProcessing(draft: Draft) {
  const phone = draft.actor_phone;
  if (current(draft)) return sendWhatsAppText(phone, 'La agenda está confirmando tu cita. Espera la respuesta antes de iniciar otra.');
  const event = await findCalendarBooking(draft.id);
  if (event && event.patientPhone === draft.details.patientPhone && Date.parse(event.start) === Date.parse(draft.details.selected?.start || '')) {
    return markConfirmed(draft);
  }
  if (event) return sendWhatsAppText(phone, 'Revisa «Mis citas» o consulta con recepción antes de reservar otra.');
  const updated = await replaceDraft(draft, 'confirm', draft.details);
  if (updated) await showConfirmation(updated);
}

async function confirm(draft: Draft) {
  const { selected, patientName, patientPhone, reason } = draft.details;
  if (!selected || !patientName || !patientPhone || !reason) return stale(draft.actor_phone);
  const lock = await replaceDraft(draft, 'processing', draft.details);
  if (!lock) return stale(draft.actor_phone);
  try {
    const result = await bookWithLock({ actionId: lock.id, patientName, patientPhone, reason, startTime: selected.start });
    if (result.state === 'confirmed') return markConfirmed(lock);
    if (result.state === 'busy') {
      const updated = await replaceDraft(lock, 'confirm', lock.details);
      if (updated) await showConfirmation(updated);
      return;
    }
    await sendWhatsAppText(draft.actor_phone, 'Ese horario se ocupó antes de confirmar. Te muestro otras opciones.');
    await offer(lock);
  } catch {
    // Keep the deterministic Calendar ID and reconcile before offering another reservation.
    await sendWhatsAppText(draft.actor_phone, 'La confirmación quedó pendiente de verificar. Espera dos minutos y vuelve a escribir para revisar el estado.');
  }
}

export async function handleBooking(phone: string, option: string | undefined, content: string): Promise<boolean> {
  const button = option?.match(/^booking_([\da-f-]{36})_(0|1|more|name|edit|confirm)$/i);
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
  const preference = !button && isScheduling ? requestedSchedule(content, reference ? clinicDate(new Date(reference.start)) : clinicDate()) : null;
  const wantsAnother = button?.[2] === 'more' || /^(?:ver )?(?:otros horarios|cambiar horario|otra hora|otra fecha)$/.test(text);
  if (draft.stage === 'confirmed') {
    if (!preference && !wantsAnother) return false;
    await sendWhatsAppText(phone, `Tu cita ya está confirmada para ${reference?.label}. Puedes verla en «Mis citas» antes de reservar otra.`);
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
      const updated = await replaceDraft(draft, 'name', { ...draft.details, selected: slot });
      if (updated) await askName(updated);
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
    } else await advance(draft, { ...draft.details, reason });
  } else if (draft.stage === 'confirm') {
    if (button && action === 'confirm') await confirm(draft);
    else if (button && action === 'edit') {
      const updated = await replaceDraft(draft, 'name', { ...draft.details, patientName: undefined, reason: undefined });
      if (updated) await askName(updated);
    } else await showConfirmation(draft);
  }
  return true;
}
