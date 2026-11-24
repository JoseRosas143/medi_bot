import { randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase';
import { findUpcomingAppointmentsByWhatsApp, getPatientVisitHistory } from '@/lib/calendar';
import { clinicIdentity, parseBusinessHours, weekdays, weeklyHours } from '@/lib/clinic-configuration';
import { formatAppointment } from '@/lib/clinic-time';
import { formatPrice, normalized, showList } from '@/lib/menus';
import { withCalendarLock } from '@/lib/calendar-lock';
import { correctedName, savePatientName } from '@/lib/patient-name';
import { describeBlock, parseScheduleBlock, removeScheduleBlock, reviewScheduleBlock, scheduleBlocks, showScheduleBlocks, type BlockAction } from '@/lib/schedule-blocks';
import { comparableWhatsApp, hasWhatsAppWindow, parseClinicWhatsApp, sendWhatsAppInteractiveButtons, sendWhatsAppText, shorten, WhatsAppError } from '@/lib/whatsapp';

type Patient = { phone: string; full_name: string | null; last_inbound_at: string | null };
type Action = 'clinic_name' | 'bot_name' | 'hours' | 'message' | 'charge' | 'payment' | 'patient_name' | BlockAction;
type Draft = { id: string; action: Action; target: string; value: string | null; expires_at: string };
const drafts = () => db.from('clinic_admin_inputs');
const expiry = () => new Date(Date.now() + 15 * 60_000).toISOString();
const panels = { id: 'admin_panel', title: 'Volver al panel' };
const columns = 'phone,full_name,last_inbound_at';
const unavailable = (phone: string) => sendWhatsAppText(phone, 'La opción cambió o venció. Abre el panel para iniciar de nuevo.');
const patientLabel = (patient: Patient) => `${shorten(patient.full_name || 'Paciente', 65)} · •••• ${patient.phone.slice(-4)}`;

async function accountBalance(phone: string) {
  const { data } = await db.rpc('patient_account_balance', { p_phone: phone }).throwOnError();
  const cents = Number(data);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Saldo inválido');
  return cents;
}

export async function showPatientBalance(phone: string) {
  const cents = await accountBalance(phone);
  await sendWhatsAppInteractiveButtons({ to: phone, bodyText: `*Mis deudas*\nSaldo pendiente ${formatPrice(cents / 100)}`,
    buttons: [{ id: 'menu_principal', title: 'Menú principal' }] });
}

async function findPatient(phone: string): Promise<Patient | null> {
  const { data } = await db.from('patients').select(columns).eq('phone', phone).maybeSingle().throwOnError();
  return data;
}

async function searchPatients(admin: string, term: string) {
  const digits = parseClinicWhatsApp(term);
  const name = term.replace(/[%*_\\]/g, '').trim().slice(0, 100);
  if (!digits && name.length < 2) return sendWhatsAppText(admin, 'Escribe «Buscar paciente» seguido de un nombre o número de WhatsApp.');
  const query = db.from('patients').select(columns).order('full_name').order('phone').limit(9);
  const canonical = digits && comparableWhatsApp(digits);
  if (canonical) query.in('phone', /^52\d{10}$/.test(canonical) ? [canonical, `521${canonical.slice(2)}`] : [canonical]);
  else query.ilike('full_name', `%${name}%`);
  const { data } = await query.throwOnError();
  const patients = (data ?? []) as Patient[];
  if (!patients.length) return sendWhatsAppText(admin, 'No encontré pacientes. Prueba con otro nombre o con el WhatsApp completo.');
  await showList(admin, `*Resultados del CRM*\n${patients.length > 8 ? 'Mostrando 8 coincidencias. Precisa la búsqueda si falta alguien.' : 'Elige un paciente.'}`,
    'Ver pacientes', [{ title: 'Pacientes', rows: patients.slice(0, 8).map(patient => ({
      id: `crm_view_${patient.phone}`, title: patient.full_name || 'Paciente', description: `WhatsApp •••• ${patient.phone.slice(-4)}`,
    })) }]);
}

async function showPatientRecord(admin: string, patient: Patient) {
  const [cents, upcoming] = await Promise.all([accountBalance(patient.phone), findUpcomingAppointmentsByWhatsApp(patient.phone)]);
  const next = upcoming[0];
  await showList(admin, `*Ficha del paciente*\n${patientLabel(patient)}\nSaldo ${formatPrice(cents / 100)}\nPróxima cita ${next ? formatAppointment(next.start) : 'Sin cita futura'}`,
    'Ver acciones', [{ title: 'Paciente', rows: [
      { id: `crm_message_${patient.phone}`, title: 'Mandar mensaje' },
      { id: `crm_visits_${patient.phone}`, title: 'Asistencia y citas' },
      { id: `crm_patient_name_${patient.phone}`, title: 'Corregir nombre' },
      { id: `crm_charge_${patient.phone}`, title: 'Agregar deuda' },
      { id: `crm_payment_${patient.phone}`, title: 'Reducir deuda' },
      { id: 'admin_crm', title: 'Buscar otro paciente' },
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
  message: 'Mandar mensaje', charge: 'Agregar deuda', payment: 'Reducir deuda',
  patient_name: 'Corregir nombre del paciente', block_dates: 'Bloquear fechas', block_hours: 'Bloquear horas',
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
    : action === 'message' ? 'Responde a este mensaje con el texto que quieres enviar.'
    : action === 'charge' || action === 'payment' ? 'Responde a este mensaje con el importe en MXN y un concepto, por ejemplo «500 Abono en recepción».'
    : 'Responde a este mensaje con el nuevo nombre.';
  const prompt = await sendWhatsAppText(admin, `*${actionNames[action]}*${label ? `\n${label}` : ''}\n\n${instructions}`);
  await drafts().upsert({ actor_phone: admin, id: randomUUID(), action, target, prompt_id: prompt, value: null, expires_at: expiry() }).throwOnError();
}

async function reviewInput(admin: string, context: string, content: string) {
  const { data } = await drafts().select('*').eq('actor_phone', admin).eq('prompt_id', context).maybeSingle().throwOnError();
  if (!data) return false;
  const draft = data as Draft;
  const value = content.trim();
  const amount = draft.action === 'charge' || draft.action === 'payment' ? amountInput(value) : null;
  const block = isBlock(draft.action) ? parseScheduleBlock(value, draft.action) : null;
  const valid = draft.action === 'hours' ? Boolean(parseBusinessHours(value))
    : isBlock(draft.action) ? Boolean(block)
    : draft.action === 'patient_name' ? Boolean(correctedName(value))
    : draft.action === 'charge' || draft.action === 'payment' ? Boolean(amount)
    : draft.action === 'message' ? Boolean(value && value.length <= 650)
    : Boolean(value && value.length <= 60 && !/[\r\n]/.test(value));
  if (!valid) {
    await sendWhatsAppText(admin, 'El dato no es válido. Responde otra vez al mensaje original con el formato indicado.');
    return true;
  }
  const isPatientAction = draft.action === 'message' || draft.action === 'charge' || draft.action === 'payment' || draft.action === 'patient_name';
  const patient = isPatientAction ? await findPatient(draft.target) : null;
  if (Date.parse(draft.expires_at) <= Date.now() || (isPatientAction && !patient)) {
    await unavailable(admin);
    return true;
  }
  const { data: updated } = await drafts().update({ value, prompt_id: null, expires_at: expiry() })
    .eq('actor_phone', admin).eq('id', draft.id).eq('prompt_id', context).select('id').maybeSingle().throwOnError();
  if (!updated) { await unavailable(admin); return true; }
  const target = patient ? patientLabel(patient) : draft.action === 'hours' ? weekdays[Number(draft.target)] : '';
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
    const patient = await findPatient(target);
    if (!patient || !hasWhatsAppWindow(patient.last_inbound_at)) return sendWhatsAppText(admin, 'La ventana de WhatsApp está cerrada. Podrás enviar el mensaje cuando el paciente vuelva a escribir.');
    try {
      await sendWhatsAppText(patient.phone, value);
    } catch (error) {
      if (error instanceof WhatsAppError && error.code === 131047) return sendWhatsAppText(admin, 'La ventana de WhatsApp venció. El paciente debe volver a escribir.');
      throw error;
    }
    return sendWhatsAppText(admin, '✅ WhatsApp aceptó el mensaje para el paciente.');
  } else {
    const amount = amountInput(value);
    if (!amount) return unavailable(admin);
    const result = await db.rpc('record_patient_account_entry', {
      p_id: id, p_phone: target, p_delta: action === 'charge' ? amount.cents : -amount.cents, p_note: amount.note,
    }).throwOnError();
    if (result.data === 'insufficient') return sendWhatsAppText(admin, 'El abono supera el saldo pendiente. Consulta el saldo en la ficha.');
    if (result.data === 'missing') return unavailable(admin);
    if (result.data !== 'saved' && result.data !== 'duplicate') throw new Error('Movimiento sin confirmar');
    return sendWhatsAppText(admin, `✅ Movimiento registrado. Saldo pendiente ${formatPrice(await accountBalance(target) / 100)}.`);
  }
  await sendWhatsAppText(admin, '✅ Cambio guardado.');
}

export async function handleClinicAdministration(admin: string, option?: string, content = '', context?: string) {
  const text = !context ? normalized(content) : '';
  if (!option && context && await reviewInput(admin, context, content)) return true;
  const search = !option && !context ? content.trim().match(/^buscar paciente(?:\s+(.+))?$/i) : null;
  const config = option?.match(/^setup_(clinic_name|bot_name|day_([0-6]))$/);
  const crm = option?.match(/^crm_(view|visits|message|charge|payment|patient_name)_([1-9]\d{7,14})$/);
  const blockPage = option?.match(/^setup_blocks_(\d{1,5})$/);
  const blockAction = option?.match(/^setup_(block_dates|block_hours)$/);
  const blockDecision = option?.match(/^setup_block_(review|remove)_([a-f0-9-]{36})$/);
  const decision = option?.match(/^clinic_(save|back)_([a-f0-9-]{36})$/);
  if (option === 'admin_config' || (!option && text === 'configuracion')) await showConfiguration(admin);
  else if (option === 'setup_hours') await showHours(admin);
  else if (blockPage) await showScheduleBlocks(admin, Number(blockPage[1]));
  else if (blockAction) await beginInput(admin, blockAction[1] as BlockAction);
  else if (blockDecision?.[1] === 'review') await reviewScheduleBlock(admin, blockDecision[2]);
  else if (blockDecision?.[1] === 'remove') await removeScheduleBlock(admin, blockDecision[2]);
  else if (option === 'admin_tasks_menu') await showList(admin, '*Pendientes*', 'Ver opciones', [{ title: 'Pendientes', rows: [
    { id: 'admin_task', title: 'Anotar pendiente' }, { id: 'admin_tasks_0', title: 'Ver pendientes' }, panels,
  ] }]);
  else if (option === 'admin_crm' || (!option && ['pacientes', 'crm'].includes(text))) await searchPatients(admin, '');
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
