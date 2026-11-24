import { randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase';
import { findUpcomingAppointmentsByWhatsApp, getPatientVisitHistory } from '@/lib/calendar';
import { clinicIdentity, parseBusinessHours, weekdays, weeklyHours } from '@/lib/clinic-configuration';
import { formatAppointment } from '@/lib/clinic-time';
import { formatPrice, normalized, showList } from '@/lib/menus';
import { withCalendarLock } from '@/lib/calendar-lock';
import { correctedName, savePatientName } from '@/lib/patient-name';
import { closeHumanChat, openHumanChat, recordChatMessage, trackHumanChatReply, type HumanPatient } from '@/lib/human-chat';
import { faqInput, findAdminFaq, isFaqAction, saveFaq, showAdminFaq, showFaqs, type FaqAction } from '@/lib/faq-admin';
import { parseWaitlistDate, showWaitlistSlots } from '@/lib/waitlist-admin';
import { offerWaitlistSlot } from '@/lib/waitlist';
import { describeBlock, parseScheduleBlock, removeScheduleBlock, reviewScheduleBlock, scheduleBlocks, showScheduleBlocks, type BlockAction } from '@/lib/schedule-blocks';
import { comparableWhatsApp, hasWhatsAppWindow, parseClinicWhatsApp, sendWhatsAppInteractiveButtons, sendWhatsAppText, shorten, WhatsAppError } from '@/lib/whatsapp';

type Patient = { phone: string; full_name: string | null; last_inbound_at: string | null };
type Action = 'clinic_name' | 'bot_name' | 'hours' | 'message' | 'charge' | 'payment' | 'patient_name'
  | BlockAction | FaqAction | 'waitlist_day' | 'waitlist_offer';
type Draft = { id: string; action: Action; target: string; value: string | null; prompt_id: string | null; expires_at: string };
const drafts = () => db.from('clinic_admin_inputs');
const expiry = () => new Date(Date.now() + 15 * 60_000).toISOString();
const panels = { id: 'admin_panel', title: 'Volver al panel' };
const columns = 'phone,full_name,last_inbound_at';
const unavailable = (phone: string) => sendWhatsAppText(phone, 'La opción cambió o venció. Abre el panel para iniciar de nuevo.');
const patientLabel = (patient: Patient) => `${shorten(patient.full_name || 'Paciente', 65)} · •••• ${patient.phone.slice(-4)}`;
const directoryPageSize = 6;
const directoryHome = { id: 'admin_crm', title: 'Directorio de pacientes' };
const closedWindow = 'La ventana de WhatsApp está cerrada. Pide al paciente que escriba a Benson y vuelve a intentar.';
const patientDirectory = () => db.from('patients').select(columns)
  .order('last_inbound_at', { ascending: false, nullsFirst: false }).order('updated_at', { ascending: false }).order('phone');
const patientRows = (patients: Patient[], action = 'view') => patients.map(patient => ({
  id: `crm_${action}_${patient.phone}`, title: patient.full_name?.trim() || 'Paciente sin nombre',
  description: `WhatsApp •••• ${patient.phone.slice(-4)}`,
}));

async function accountBalance(phone: string) {
  const { data } = await db.rpc('patient_account_balance', { p_phone: phone }).throwOnError();
  const cents = Number(data);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Saldo inválido');
  return cents;
}

async function accountPage(phone: string, page: number) {
  const size = 5;
  const { data } = await db.rpc('patient_account_statement', { p_phone: phone, p_offset: page * size }).throwOnError();
  const { balance_cents: cents, entries } = data as { balance_cents: number; entries: { delta_cents: number; note: string }[] };
  const lines = entries.slice(0, size).reverse().map(entry =>
    `${entry.delta_cents > 0 ? '+' : '−'}${formatPrice(Math.abs(entry.delta_cents) / 100)} · ${shorten(entry.note, 100)}`);
  const balance = `Saldo pendiente ${formatPrice(cents / 100)}`;
  return { detail: `${lines.length ? `${lines.join('\n')}\n\n` : ''}${balance}`, more: entries.length > size };
}

async function showAccount(actor: string, phone: string, page: number, admin = false, saved = false) {
  const { detail, more } = await accountPage(phone, page);
  const prefix = admin ? `crm_account_${phone}_` : 'my_debts_';
  await sendWhatsAppInteractiveButtons({ to: actor, bodyText: `${saved ? '✅ Movimiento registrado.\n\n' : ''}*${admin ? 'Movimientos de cuenta' : 'Mis deudas'}*\n${detail}`,
    buttons: [
      ...(page ? [{ id: prefix + (page - 1), title: 'Más recientes' }] : []),
      ...(more ? [{ id: prefix + (page + 1), title: 'Más antiguos' }] : []),
      admin ? { id: `crm_view_${phone}`, title: 'Volver a la ficha' } : { id: 'menu_principal', title: 'Menú principal' },
    ] });
}

export function showPatientBalance(phone: string, page = 0) {
  return showAccount(phone, phone, page);
}

async function findPatient(phone: string): Promise<Patient | null> {
  const { data } = await db.from('patients').select(columns).eq('phone', phone).maybeSingle().throwOnError();
  return data;
}

async function showPatientDirectory(admin: string, page = 0, message = false) {
  const offset = page * directoryPageSize;
  const { data } = await patientDirectory().range(offset, offset + directoryPageSize).throwOnError();
  const patients = (data ?? []) as Patient[];
  const rows = patientRows(patients.slice(0, directoryPageSize), message ? 'message' : 'view');
  const prefix = message ? 'crm_message_page_' : 'crm_directory_';
  await showList(admin, `*${message ? 'Enviar mensaje a número' : 'Directorio de pacientes'}*\n${rows.length ? 'Los contactos que hablaron más recientemente aparecen primero.'
    : page ? 'Esta página ya no tiene pacientes. Vuelve a la primera para actualizar.' : 'Aún no hay pacientes registrados.'}`,
  'Ver pacientes', [
    ...(rows.length ? [{ title: 'Pacientes', rows }] : []),
    { title: 'Navegación', rows: [
      message ? { id: 'crm_message_manual', title: 'Escribir número' } : { id: 'crm_search', title: 'Buscar paciente' },
      ...(page > 0 ? [{ id: prefix + (page - 1), title: 'Página anterior' }] : []),
      ...(patients.length > directoryPageSize ? [{ id: prefix + (page + 1), title: 'Página siguiente' }] : []),
      panels,
    ] },
  ], 'Para abrir una ficha por búsqueda, escribe «Buscar paciente» y un nombre, un WhatsApp o sus últimos cuatro dígitos.');
}

async function searchPatientNames(tokens: string[]) {
  const longest = tokens.reduce((a, b) => a.length >= b.length ? a : b);
  // The candidate query preserves accents in storage. Filter its broader matches against the folded name.
  const pattern = `%${longest.replace(/[aeioun]/g, '_')}%`;
  const patients: Patient[] = [];
  const batch = 80;
  for (let offset = 0; offset < 800; offset += batch) {
    const { data } = await patientDirectory().ilike('full_name', pattern).range(offset, offset + batch - 1).throwOnError();
    const matches = ((data ?? []) as Patient[]).filter(patient =>
      tokens.every(token => normalized(patient.full_name || '').includes(token)));
    patients.push(...matches.slice(0, 9 - patients.length));
    if (patients.length >= 9 || (data?.length ?? 0) < batch) return { patients, broad: false };
  }
  return { patients, broad: true };
}

async function searchPatients(admin: string, term: string) {
  const digits = parseClinicWhatsApp(term);
  const suffix = /^\d{4,9}$/.test(term.trim()) ? term.trim() : null;
  const tokens = normalized(term.slice(0, 100)).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!digits && !suffix && !tokens.some(token => token.length >= 2)) {
    return sendWhatsAppText(admin, 'Escribe «Buscar paciente» seguido de un nombre, WhatsApp o sus últimos cuatro dígitos. Por ejemplo, «Buscar paciente Ana» o «Buscar paciente 5034».');
  }
  let patients: Patient[];
  let broad = false;
  if (digits || suffix) {
    const query = patientDirectory().limit(9);
    if (digits) {
      const phone = comparableWhatsApp(digits);
      query.in('phone', /^52\d{10}$/.test(phone) ? [phone, `521${phone.slice(2)}`] : [phone]);
    } else query.like('phone', `%${suffix}`);
    const { data } = await query.throwOnError();
    patients = (data ?? []) as Patient[];
  } else ({ patients, broad } = await searchPatientNames(tokens));
  if (!patients.length) return sendWhatsAppText(admin, broad
    ? 'Hay muchos perfiles para revisar. Añade un apellido o busca por WhatsApp.'
    : 'No encontré coincidencias. Prueba con un nombre más corto, los últimos cuatro dígitos o abre «Pacientes · CRM».');
  await showList(admin, `*Resultados del CRM*\n${broad || patients.length > 8 ? 'Puedes precisar la búsqueda si falta alguien.' : 'Elige un paciente.'}`,
    'Ver pacientes', [{ title: 'Pacientes', rows: patientRows(patients.slice(0, 8)) }, { title: 'Navegación', rows: [directoryHome] }]);
}

async function showPatientRecord(admin: string, patient: Patient) {
  const [cents, upcoming] = await Promise.all([accountBalance(patient.phone), findUpcomingAppointmentsByWhatsApp(patient.phone)]);
  const next = upcoming[0];
  await showList(admin, `*Ficha del paciente*\n${patientLabel(patient)}\nSaldo ${formatPrice(cents / 100)}\nPróxima cita ${next ? formatAppointment(next.start) : 'Sin cita futura'}`,
    'Ver acciones', [{ title: 'Paciente', rows: [
      { id: `crm_message_${patient.phone}`, title: 'Enviar mensaje' },
      { id: `crm_visits_${patient.phone}`, title: 'Asistencia y citas' },
      { id: `crm_patient_name_${patient.phone}`, title: 'Corregir nombre' },
      { id: `crm_charge_${patient.phone}`, title: 'Agregar deuda' },
      { id: `crm_payment_${patient.phone}`, title: 'Reducir deuda' },
      { id: `crm_account_${patient.phone}_0`, title: 'Ver movimientos' },
      directoryHome,
    ] }]);
}

async function showVisits(admin: string, patient: Patient) {
  const now = Date.now();
  const past = await getPatientVisitHistory(patient.phone, new Date(now - 180 * 86_400_000).toISOString(), new Date(now).toISOString());
  const sorted = past.filter(item => Date.parse(item.start) < now).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const arrived = sorted.filter(item => item.visitStatus === 'arrived').length;
  const noShow = sorted.filter(item => item.visitStatus === 'no_show').length;
  const lines = sorted.slice(0, 8).map(item => `• ${formatAppointment(item.start)} · ${item.visitStatus === 'arrived' ? 'Llegó'
    : item.visitStatus === 'no_show' ? 'No asistió' : 'Sin registro'}`);
  await sendWhatsAppInteractiveButtons({ to: admin,
    bodyText: `*Asistencia · últimos 180 días*\n${patientLabel(patient)}\nLlegó ${arrived} · No asistió ${noShow}\n\n${lines.join('\n') || 'Sin visitas registradas.'}`,
    buttons: [{ id: `crm_view_${patient.phone}`, title: 'Volver a la ficha' }],
  });
}

async function showConfiguration(admin: string) {
  const identity = await clinicIdentity();
  await showList(admin, `*Configuración*\nClínica · ${identity.clinic}\nBot · ${identity.bot}`, 'Ver opciones',
    [{ title: 'Configuración', rows: [
      { id: 'setup_clinic_name', title: 'Nombre de la clínica' }, { id: 'setup_bot_name', title: 'Nombre del bot' },
      { id: 'setup_hours', title: 'Horario de atención' }, { id: 'setup_blocks_0', title: 'Bloqueos de agenda' },
      { id: 'admin_cerrar_chat', title: 'Cerrar chat directo' }, panels,
    ] }]);
}

async function showHours(admin: string) {
  const week = await weeklyHours();
  await showList(admin, '*Horario de atención*\nElige el día que quieres cambiar.', 'Ver días', [{ title: 'Horario semanal', rows: [
    ...week.map(day => ({ id: `setup_day_${day.weekday}`, title: weekdays[day.weekday],
      description: day.opens_at ? `${day.opens_at.slice(0, 5)} a ${day.closes_at?.slice(0, 5)}` : 'Cerrado' })),
    { id: 'admin_config', title: 'Volver a configuración' },
  ] }]);
}

const actionNames: Record<Action, string> = {
  clinic_name: 'Nombre de la clínica', bot_name: 'Nombre del bot', hours: 'Horario de atención',
  message: 'Enviar mensaje', charge: 'Agregar deuda', payment: 'Reducir deuda',
  patient_name: 'Corregir nombre del paciente', block_dates: 'Bloquear fechas', block_hours: 'Bloquear horas',
  faq_add: 'Agregar pregunta', faq_question: 'Editar pregunta', faq_answer: 'Editar respuesta', faq_hide: 'Retirar pregunta',
  waitlist_day: 'Elegir día para la oferta', waitlist_offer: 'Enviar oferta',
};

const isBlock = (action: Action): action is BlockAction => action === 'block_dates' || action === 'block_hours';

function amountInput(input: string) {
  const match = input.trim().match(/^\$?(\d{1,8}(?:\.\d{1,2})?)\s+([\s\S]{1,160})$/);
  if (!match) return null;
  const cents = Math.round(Number(match[1]) * 100);
  const note = match[2].trim();
  return cents > 0 && cents <= 2_147_483_647 && note ? { cents, note } : null;
}

async function beginInput(admin: string, action: Action, target = '', label = '') {
  const instructions = action === 'hours' ? 'Responde a este mensaje con «13:00-17:00» o «Cerrado».'
    : action === 'block_dates' ? 'Responde con una fecha «AAAA-MM-DD» o un rango «AAAA-MM-DD a AAAA-MM-DD». Incluye el último día que tenga que quedar cerrado.'
    : action === 'block_hours' ? 'Responde con la fecha y las horas en formato «AAAA-MM-DD 13:00-15:00».'
    : action === 'waitlist_day' ? 'Escribe la fecha que quieres revisar, por ejemplo «28/11/2026».'
    : action === 'faq_add' ? 'Responde con la pregunta y la respuesta separadas por |. Ejemplo: «¿Dónde están? | Estamos en Puebla».'
    : action === 'faq_question' || action === 'faq_answer' ? 'Responde a este mensaje con el texto nuevo.'
    : action === 'message' ? (target ? 'Responde a este mensaje con el texto que quieres enviar.'
      : 'Escribe el WhatsApp del paciente. Usa 10 dígitos para México o incluye el código de país.')
    : action === 'charge' || action === 'payment' ? 'Escribe el importe en MXN y el concepto, por ejemplo «500 Resina» o «800 Depósito». Te mostraré el movimiento antes de guardarlo.'
    : 'Responde a este mensaje con el nuevo nombre.';
  const prompt = await sendWhatsAppText(admin, `*${actionNames[action]}*${label ? `\n${label}` : ''}\n\n${instructions}`);
  await drafts().upsert({ actor_phone: admin, id: randomUUID(), action, target, prompt_id: prompt, value: null, expires_at: expiry() }).throwOnError();
}

async function chooseMessageContact(admin: string, input: string) {
  const digits = parseClinicWhatsApp(input);
  if (!digits) return sendWhatsAppText(admin, 'Escribe un número de WhatsApp válido. Usa 10 dígitos o incluye el código de país.');
  const canonical = comparableWhatsApp(digits);
  const numbers = /^52\d{10}$/.test(canonical) ? [canonical, `521${canonical.slice(2)}`] : [canonical];
  const { data } = await db.from('patients').select(columns).in('phone', numbers).limit(2).throwOnError();
  if (data?.length === 2) return sendWhatsAppText(admin, 'Encontré dos fichas con ese número. Abre la ficha correcta desde «Pacientes · CRM».');
  const patient = data?.[0] as Patient | undefined;
  if (!patient || !hasWhatsAppWindow(patient.last_inbound_at)) return sendWhatsAppText(admin, closedWindow);
  return beginInput(admin, 'message', patient.phone, patientLabel(patient));
}

async function reviewInput(admin: string, draft: Draft, content: string) {
  if (Date.parse(draft.expires_at) <= Date.now()) {
    await unavailable(admin);
    return true;
  }
  if (draft.action === 'message' && !draft.target) {
    await chooseMessageContact(admin, content);
    return true;
  }
  if (draft.action === 'waitlist_day') {
    const date = parseWaitlistDate(content);
    if (date) await showWaitlistSlots(admin, draft.target, date);
    else await sendWhatsAppText(admin, 'Escribe una fecha vigente en formato DD/MM/AAAA, por ejemplo «28/11/2026».');
    return true;
  }
  const value = content.trim();
  const amount = draft.action === 'charge' || draft.action === 'payment' ? amountInput(value) : null;
  const block = isBlock(draft.action) ? parseScheduleBlock(value, draft.action) : null;
  const valid = draft.action === 'hours' ? Boolean(parseBusinessHours(value))
    : isBlock(draft.action) ? Boolean(block)
    : draft.action === 'patient_name' ? Boolean(correctedName(value))
    : draft.action === 'charge' || draft.action === 'payment' ? Boolean(amount)
    : isFaqAction(draft.action) ? Boolean(faqInput(draft.action, value))
    : draft.action === 'message' ? Boolean(value && value.length <= 650)
    : Boolean(value && value.length <= 60 && !/[\r\n]/.test(value));
  if (!valid) {
    await sendWhatsAppText(admin, 'El dato no es válido. Responde otra vez al mensaje original con el formato indicado.');
    return true;
  }
  const isPatientAction = draft.action === 'message' || draft.action === 'charge' || draft.action === 'payment' || draft.action === 'patient_name';
  const patient = isPatientAction ? await findPatient(draft.target) : null;
  if (isPatientAction && !patient) {
    await unavailable(admin);
    return true;
  }
  const { data: updated } = await drafts().update({ value, prompt_id: null, expires_at: expiry() })
    .eq('actor_phone', admin).eq('id', draft.id).eq('prompt_id', draft.prompt_id).select('id').maybeSingle().throwOnError();
  if (!updated) { await unavailable(admin); return true; }
  const target = patient ? patientLabel(patient) : draft.action === 'hours' ? weekdays[Number(draft.target)]
    : isFaqAction(draft.action) && draft.target ? (JSON.parse(draft.target) as { question: string }).question : '';
  const detail = amount ? `${formatPrice(amount.cents / 100)} · ${amount.note}` : block ? describeBlock(block) : value;
  await sendWhatsAppInteractiveButtons({ to: admin, bodyText: `*Confirma el cambio*\n${actionNames[draft.action]}${target ? ` · ${target}` : ''}\n\n${detail}`, buttons: [
    { id: `clinic_save_${draft.id}`, title: draft.action === 'message' ? 'Enviar mensaje' : 'Guardar cambio' },
    { id: `clinic_back_${draft.id}`, title: 'Descartar' },
  ] });
  return true;
}

async function claimInput(admin: string, id: string) {
  const { data } = await drafts().delete().eq('actor_phone', admin).eq('id', id)
    .is('prompt_id', null).gt('expires_at', new Date().toISOString()).select('*').maybeSingle().throwOnError();
  return data as Draft | null;
}

async function applyScheduleBlock(admin: string, id: string) {
  const result = await withCalendarLock(id, async () => {
    const draft = await claimInput(admin, id);
    const interval = draft?.value && isBlock(draft.action) ? parseScheduleBlock(draft.value, draft.action) : null;
    if (!interval) return { state: 'missing' } as const;
    await scheduleBlocks().insert({ id, ...interval }).throwOnError();
    return { state: 'saved' } as const;
  });
  if (result.state === 'busy') return sendWhatsAppInteractiveButtons({ to: admin,
    bodyText: 'La agenda está verificando una cita. Puedes intentar guardar el bloqueo otra vez.', buttons: [
      { id: `clinic_save_${id}`, title: 'Reintentar' }, { id: `clinic_back_${id}`, title: 'Descartar' },
    ] });
  if (result.state === 'missing') return unavailable(admin);
  await sendWhatsAppText(admin, '✅ Bloqueo guardado para nuevas reservas y cambios de horario. Las citas que ya existen se conservan.');
}

async function sendReceptionMessage(admin: string, target: string, value: string) {
  const { data } = await db.from('patients').select(`${columns},chat_mode,human_session_id`).eq('phone', target).maybeSingle().throwOnError();
  const patient = data as (Patient & HumanPatient) | null;
  if (!patient || !hasWhatsAppWindow(patient.last_inbound_at)) return sendWhatsAppText(admin, closedWindow);
  const opening = patient.chat_mode === 'AI_ACTIVE';
  const sessionId = opening ? await openHumanChat(target) : patient.human_session_id;
  if (!sessionId) return sendWhatsAppText(admin, 'La conversación cambió. Abre la ficha y vuelve a intentar.');
  const session = { phone: target, human_session_id: sessionId };
  try {
    await sendWhatsAppText(target, value);
  } catch (error) {
    if (opening) await closeHumanChat(session);
    if (error instanceof WhatsAppError && error.code === 131047) return sendWhatsAppText(admin, closedWindow);
    throw error;
  }
  await recordChatMessage(target, 'doctor', value);
  const receipt = await sendWhatsAppInteractiveButtons({ to: admin,
    bodyText: `✅ WhatsApp aceptó el mensaje para ${patientLabel(patient)}.\n\nSus respuestas llegarán a recepción. Desliza este aviso para enviar otro mensaje.`,
    buttons: [{ id: `chat_close_${target}_${sessionId}`, title: 'Cerrar chat' }],
  });
  await trackHumanChatReply(receipt, session);
}

async function applyInput(admin: string, id: string, save: boolean) {
  if (save) {
    const { data: pending } = await drafts().select('action').eq('actor_phone', admin).eq('id', id).maybeSingle().throwOnError();
    if (pending && isBlock(pending.action as Action)) return applyScheduleBlock(admin, id);
  }
  const data = await claimInput(admin, id);
  if (!data) return unavailable(admin);
  if (!save) return sendWhatsAppText(admin, 'Cambio descartado.');
  const { action, target, value } = data as Draft;
  if (!value) return unavailable(admin);
  if (action === 'bot_name' || action === 'clinic_name') {
    await db.from('bot_settings').update({ [action]: value }).eq('id', 1).select('id').single().throwOnError();
  } else if (action === 'hours') {
    const hours = parseBusinessHours(value);
    if (!hours) return unavailable(admin);
    await db.from('clinic_weekly_hours').update(hours).eq('weekday', Number(target)).select('weekday').single().throwOnError();
  } else if (action === 'patient_name') {
    const name = correctedName(value);
    if (!name || !await savePatientName(target, name)) return unavailable(admin);
  } else if (action === 'message') {
    return sendReceptionMessage(admin, target, value);
  } else if (isFaqAction(action)) {
    return saveFaq(admin, action, target, value);
  } else if (action === 'waitlist_offer') {
    const state = await offerWaitlistSlot(target, value);
    const reply = state === 'sent' ? '✅ WhatsApp aceptó la oferta. La cita sigue igual hasta que el paciente acepte.'
      : state === 'unknown' ? 'El envío quedó pendiente de verificar. Revisa el historial antes de enviar otra oferta.'
      : state === 'closed_window' ? 'La ventana del paciente se cerró y falta una plantilla activa para ofertas.'
      : state === 'busy' ? 'La agenda está verificando otra operación. Vuelve a elegir un espacio.'
      : state === 'already_offered' ? 'El espacio o el paciente ya tienen una oferta vigente.'
      : state === 'rejected' ? 'WhatsApp rechazó la oferta. La cita conserva su horario.'
      : 'El horario o la solicitud cambió. Elige otro espacio.';
    return sendWhatsAppText(admin, reply);
  } else {
    const amount = amountInput(value);
    if (!amount) return unavailable(admin);
    const result = await db.rpc('record_patient_account_entry', {
      p_id: id, p_phone: target, p_delta: action === 'charge' ? amount.cents : -amount.cents, p_note: amount.note,
    }).throwOnError();
    if (result.data === 'insufficient') return sendWhatsAppText(admin, 'El abono supera el saldo pendiente. Consulta el saldo en la ficha.');
    if (result.data === 'missing') return unavailable(admin);
    if (result.data !== 'saved' && result.data !== 'duplicate') throw new Error('Movimiento sin confirmar');
    return showAccount(admin, target, 0, true, true);
  }
  await sendWhatsAppText(admin, '✅ Cambio guardado.');
}

export async function handleClinicAdministration(admin: string, option?: string, content = '', context?: string) {
  const text = !context ? normalized(content) : '';
  const phoneInput = !option && !context && parseClinicWhatsApp(content);
  if (!option && (context || phoneInput || /^\s*\$?\d/.test(content))) {
    const { data } = await drafts().select('*').eq('actor_phone', admin).maybeSingle().throwOnError();
    const draft = data as Draft | null;
    const direct = !context && draft && (draft.action === 'charge' || draft.action === 'payment' || draft.action === 'waitlist_day' ||
      (draft.action === 'message' && !draft.target && phoneInput));
    if (draft?.prompt_id && (draft.prompt_id === context || direct)) return reviewInput(admin, draft, content);
    if (!context && /^\s*\$?\d+(?:[.,]\d+)?\s+\p{L}/u.test(content)) {
      await sendWhatsAppText(admin, 'Para registrar un importe, abre la ficha del paciente y elige «Agregar deuda» o «Reducir deuda».');
      return true;
    }
  }
  const search = !option && !context ? content.trim().match(/^buscar paciente(?:\s+(.+))?$/i) : null;
  const directoryPage = option?.match(/^crm_directory_(\d{1,5})$/);
  const messagePage = option?.match(/^crm_message_page_(\d{1,5})$/);
  const account = option?.match(/^crm_account_([1-9]\d{7,14})_(\d{1,5})$/);
  const config = option?.match(/^setup_(clinic_name|bot_name|day_([0-6]))$/);
  const crm = option?.match(/^crm_(view|visits|message|charge|payment|patient_name)_([1-9]\d{7,14})$/);
  const blockPage = option?.match(/^setup_blocks_(\d{1,5})$/);
  const blockAction = option?.match(/^setup_(block_dates|block_hours)$/);
  const blockDecision = option?.match(/^setup_block_(review|remove)_([a-f0-9-]{36})$/);
  const decision = option?.match(/^clinic_(save|back)_([a-f0-9-]{36})$/);
  const faqPage = option?.match(/^faq_admin_page_(\d{1,5})$/);
  const faq = option?.match(/^faq_admin_(view|question|answer|hide)_(\d{1,9})$/);
  const waitlistDay = option?.match(/^admin_wait_day_([a-f0-9-]{36})$/);
  const waitlistSlot = option?.match(/^admin_wait_slot_([a-f0-9-]{36})_(\d{13})$/);
  if (option === 'admin_message_number' || messagePage || (!option && text === 'enviar mensaje a numero')) {
    await showPatientDirectory(admin, Number(messagePage?.[1] || 0), true);
  }
  else if (option === 'crm_message_manual') await beginInput(admin, 'message');
  else if (account) await showAccount(admin, account[1], Number(account[2]), true);
  else if (waitlistDay) await beginInput(admin, 'waitlist_day', waitlistDay[1]);
  else if (waitlistSlot) {
    const start = new Date(Number(waitlistSlot[2])).toISOString();
    const id = randomUUID();
    await drafts().upsert({ actor_phone: admin, id, action: 'waitlist_offer', target: waitlistSlot[1], prompt_id: null,
      value: start, expires_at: expiry() }).throwOnError();
    await sendWhatsAppInteractiveButtons({ to: admin,
      bodyText: `*Confirmar oferta*\n${formatAppointment(start)}\nLa cita se moverá únicamente si el paciente acepta y el espacio sigue libre.`,
      buttons: [{ id: `clinic_save_${id}`, title: 'Enviar oferta' }, { id: `clinic_back_${id}`, title: 'Descartar' }] });
  }
  else if (option === 'adm_add_faq') await beginInput(admin, 'faq_add');
  else if (option === 'adm_edit_faq' || faqPage || (!option && text === 'editar pregunta')) await showFaqs(admin, Number(faqPage?.[1] || 0));
  else if (faq) {
    const entry = await findAdminFaq(Number(faq[2]));
    if (!entry) await unavailable(admin);
    else if (faq[1] === 'view') await showAdminFaq(admin, entry);
    else if (faq[1] === 'hide') {
      const id = randomUUID();
      await drafts().upsert({ actor_phone: admin, id, action: 'faq_hide', target: JSON.stringify(entry), prompt_id: null,
        value: 'retirar', expires_at: expiry() }).throwOnError();
      await sendWhatsAppInteractiveButtons({ to: admin, bodyText: `*¿Retirar esta pregunta del menú?*\n${entry.question}`,
        buttons: [{ id: `clinic_save_${id}`, title: 'Sí, retirar' }, { id: `clinic_back_${id}`, title: 'Descartar' }] });
    } else await beginInput(admin, `faq_${faq[1]}` as FaqAction, JSON.stringify(entry), entry.question);
  }
  else if (option === 'admin_config' || (!option && text === 'configuracion')) await showConfiguration(admin);
  else if (option === 'setup_hours') await showHours(admin);
  else if (blockPage) await showScheduleBlocks(admin, Number(blockPage[1]));
  else if (blockAction) await beginInput(admin, blockAction[1] as BlockAction);
  else if (blockDecision?.[1] === 'review') await reviewScheduleBlock(admin, blockDecision[2]);
  else if (blockDecision?.[1] === 'remove') await removeScheduleBlock(admin, blockDecision[2]);
  else if (option === 'admin_tasks_menu') await showList(admin, '*Pendientes*', 'Ver opciones', [{ title: 'Pendientes', rows: [
    { id: 'admin_task', title: 'Anotar pendiente' }, { id: 'admin_tasks_0', title: 'Ver pendientes' }, panels,
  ] }]);
  else if (option === 'admin_crm' || directoryPage || (!option && ['pacientes', 'crm'].includes(text))) {
    await showPatientDirectory(admin, Number(directoryPage?.[1] || 0));
  }
  else if (option === 'crm_search') await searchPatients(admin, '');
  else if (search) await searchPatients(admin, search[1] || '');
  else if (config) await beginInput(admin, config[2] === undefined ? config[1] as Action : 'hours', config[2], config[2] ? weekdays[Number(config[2])] : '');
  else if (decision) await applyInput(admin, decision[2], decision[1] === 'save');
  else if (crm) {
    const patient = await findPatient(crm[2]);
    if (!patient) await unavailable(admin);
    else if (crm[1] === 'view') await showPatientRecord(admin, patient);
    else if (crm[1] === 'visits') await showVisits(admin, patient);
    else await beginInput(admin, crm[1] as Action, patient.phone, patientLabel(patient));
  } else return false;
  return true;
}
