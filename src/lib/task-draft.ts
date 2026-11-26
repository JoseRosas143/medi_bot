import { randomUUID } from 'node:crypto';
import { addClinicTask } from '@/lib/clinic-tasks';
import { CLINIC_TIMEZONE, clinicDate, clinicInstant, formatAppointment, nextDate, parseClinicDateInput } from '@/lib/clinic-time';
import { normalized, showList } from '@/lib/menus';
import { supabaseAdmin as db } from '@/lib/supabase';
import { sendWhatsAppInteractiveButtons, sendWhatsAppText, shorten } from '@/lib/whatsapp';

type Stage = 'description' | 'reminder' | 'date' | 'custom_date' | 'time' | 'custom_time' | 'confirm';
type Task = { stage: Stage; description?: string; date?: string; time?: string };
type Draft = { id: string; target: string; prompt_id: string | null; value: string | null; expires_at: string };
const drafts = () => db.from('clinic_admin_inputs');
const expiry = () => new Date(Date.now() + 15 * 60_000).toISOString();
const stale = (admin: string) => sendWhatsAppText(admin, 'Ese paso cambió o venció. Usa el último mensaje o abre «Anotar pendiente» de nuevo.');
const dayLabel = new Intl.DateTimeFormat('es-MX', { timeZone: CLINIC_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' });
const openText = /^(?:anota|anotar)(?:\s+(?:un\s+)?pendiente)?(?:\s+([\s\S]+))?$/i;
const shortcuts = new Set(['ayuda', 'hola', 'menu', 'inicio', 'opciones', 'menu principal', 'pendientes', 'ver pendientes',
  'mis pendientes', 'lista de pendientes', 'borrar pendientes', 'agenda de hoy', 'agenda de manana', 'lista de espera',
  'crm', 'pacientes', 'crear cita', 'agendar cita', 'reservar cita', 'administrar cita', 'configuracion']);
const freeInputStages: Stage[] = ['description', 'custom_date', 'custom_time'];
const descriptionText = (message: string) => message.split(/\s+y\s+recu[eé]rdam(?:e|elo)\b/i)[0].trim();

function formatTime(date: string | undefined, hour: string | undefined) {
  if (!date || !hour) return null;
  try {
    const at = clinicInstant(date, hour);
    return at.getTime() > Date.now() ? at.toISOString() : null;
  } catch {
    return null;
  }
}

function pageRows<T>(rows: T[], page: number, button: (action: string) => string, prefix: string) {
  const size = 6;
  const offset = page * size;
  return {
    rows: rows.slice(offset, offset + size),
    navigation: [
      ...(page > 0 ? [{ id: button(prefix + (page - 1)), title: 'Página anterior' }] : []),
      ...(rows.length > offset + size ? [{ id: button(prefix + (page + 1)), title: 'Página siguiente' }] : []),
    ],
  };
}

async function showStep(admin: string, id: string, task: Task, page = 0) {
  const button = (action: string) => `admin_td_${id}_${action}`;
  const cancel = { id: button('cancel'), title: 'Cancelar' };
  if (task.stage === 'date') {
    const today = clinicDate();
    const dates = Array.from({ length: 30 }, (_, i) => nextDate(today, i));
    const dateOptions = dates.map(date => ({
      id: button(`on_${date}`), title: dayLabel.format(clinicInstant(date, '12:00')),
      description: date === today ? 'Hoy' : date === nextDate(today) ? 'Mañana' : undefined,
    }));
    const { rows, navigation } = pageRows(dateOptions, page, button, 'dates_');
    await showList(admin, '*¿Qué día quieres el recordatorio?*\nElige una fecha de los próximos 30 días.', 'Ver fechas', [
      ...(rows.length ? [{ title: 'Fechas', rows }] : []),
      { title: 'Navegación', rows: [...navigation, { id: button('another_date'), title: 'Otra fecha' }, cancel] },
    ]);
    return null;
  }
  if (task.stage === 'time') {
    const times = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`)
      .filter(hour => formatTime(task.date, hour));
    const { rows, navigation } = pageRows(times.map(hour => ({
      id: button(`at_${hour}`), title: hour,
    })), page, button, 'times_');
    await showList(admin, `*¿A qué hora quieres el recordatorio?*\n${task.date ? dayLabel.format(clinicInstant(task.date, '12:00')) : ''} · hora local de la clínica.`,
      'Ver horas', [
        ...(rows.length ? [{ title: 'Horas', rows }] : []),
        { title: 'Navegación', rows: [...navigation, { id: button('another_time'), title: 'Otra hora' },
          { id: button('back_dates'), title: 'Cambiar fecha' }] },
      ]);
    return null;
  }
  if (task.stage === 'description' || task.stage === 'custom_date' || task.stage === 'custom_time') {
    const prompt = task.stage === 'description' ? '*¿Qué pendiente quieres anotar?*\nResponde con la descripción.'
      : task.stage === 'custom_date' ? '*Escribe la fecha*\nUsa el formato DD/MM/AAAA.' : '*Escribe la hora*\nUsa el formato HH:MM, por ejemplo 09:30 o 17:45.';
    return sendWhatsAppInteractiveButtons({ to: admin, bodyText: prompt, buttons: [cancel] });
  }
  if (task.stage === 'reminder') {
    await sendWhatsAppInteractiveButtons({ to: admin, bodyText: `*${shorten(task.description ?? '', 600)}*\n\n¿Quieres programar un recordatorio?`,
      buttons: [{ id: button('with'), title: 'Con recordatorio' }, { id: button('without'), title: 'Sin recordatorio' }, cancel] });
    return null;
  }
  const at = formatTime(task.date, task.time);
  await sendWhatsAppInteractiveButtons({ to: admin,
    bodyText: `*Revisa tu pendiente*\n${shorten(task.description ?? '', 720)}\n\n${at ? `Recordatorio para ${formatAppointment(at)}` : 'Sin recordatorio.'}`,
    buttons: [{ id: button('save'), title: 'Guardar pendiente' }, { id: button('change'), title: 'Cambiar opciones' }, cancel],
  });
  return null;
}

async function nextStep(admin: string, task: Task, previous?: Draft) {
  const id = randomUUID();
  const prompt = await showStep(admin, id, task);
  const row = { id, actor_phone: admin, action: 'task_create', target: JSON.stringify(task),
    prompt_id: prompt, value: prompt ? null : task.stage, expires_at: expiry() };
  if (previous) {
    let update = drafts().update(row).eq('actor_phone', admin).eq('id', previous.id);
    update = previous.value === null ? update.is('value', null) : update.eq('value', previous.value);
    const { data } = await update.select('id').maybeSingle().throwOnError();
    if (!data) await stale(admin);
  } else await drafts().upsert(row).throwOnError();
}

export function startTaskDraft(admin: string, description?: string) {
  const note = description?.trim().slice(0, 1500);
  return nextStep(admin, note ? { stage: 'reminder', description: note } : { stage: 'description' });
}

async function finishTaskDraft(admin: string, draft: Draft, task: Task) {
  if (task.date && !formatTime(task.date, task.time)) {
    return nextStep(admin, { stage: 'date', description: task.description }, draft);
  }
  if (draft.value !== 'saving') {
    const { data } = await drafts().update({ value: 'saving' }).eq('actor_phone', admin).eq('id', draft.id)
      .eq('value', 'confirm').select('id').maybeSingle().throwOnError();
    if (!data) return stale(admin);
  }
  const message = await addClinicTask({ description: task.description, reminder_requested: Boolean(task.date), date: task.date, time: task.time }, draft.id);
  await drafts().delete().eq('actor_phone', admin).eq('id', draft.id).throwOnError();
  await sendWhatsAppInteractiveButtons({ to: admin, bodyText: message, buttons: [
    { id: 'admin_tasks_0', title: 'Ver pendientes' }, { id: 'admin_task', title: 'Anotar otro' },
  ] });
}

export async function handleTaskDraft(admin: string, option: string | undefined, content: string, context?: string) {
  const button = option?.match(/^admin_td_([a-f0-9-]{36})_([a-z0-9_:-]+)$/);
  const message = content.trim();
  if (option === 'admin_task') { await startTaskDraft(admin); return true; }
  const taskNumberCommand = /^(?:pendiente|completar|recu[eé]rdame)\s+#?\d/i.test(message);
  if (!button && (option || (!context && (shortcuts.has(normalized(message)) || taskNumberCommand)))) return false;
  const { data } = await drafts().select('id,target,prompt_id,value,expires_at').eq('actor_phone', admin)
    .eq('action', 'task_create').maybeSingle().throwOnError();
  const draft = data as Draft | null;
  const active = draft && Date.parse(draft.expires_at) > Date.now();
  const open = !option && !context && message.match(openText);
  if (open && !active) {
    await startTaskDraft(admin, open[1] && descriptionText(open[1]));
    return true;
  }
  if (!active || (button && draft.id !== button[1])) {
    if (button || (draft?.prompt_id && context === draft.prompt_id)) { await stale(admin); return true; }
    return false;
  }
  const task = JSON.parse(draft.target) as Task;
  const step = (stage: Stage, values = {}) => nextStep(admin, { ...task, ...values, stage }, draft);
  if (!button) {
    if (context && context !== draft.prompt_id) return false;
    if (!freeInputStages.includes(task.stage)) {
      await sendWhatsAppText(admin, 'Elige una opción del último mensaje para continuar con el pendiente.');
      return true;
    }
    if (task.stage === 'description') {
      const description = descriptionText(message.match(openText)?.[1] ?? message);
      if (!description || description.length > 1500) await sendWhatsAppText(admin, 'Escribe una descripción de hasta 1,500 caracteres.');
      else await step('reminder', { description });
    } else if (task.stage === 'custom_date') {
      const date = parseClinicDateInput(message);
      if (date) await step('time', { date });
      else await sendWhatsAppText(admin, 'Escribe una fecha vigente en formato DD/MM/AAAA.');
    } else {
      const match = message.match(/^(\d{1,2}):(\d{2})$/);
      const time = match ? `${match[1].padStart(2, '0')}:${match[2]}` : undefined;
      if (formatTime(task.date, time)) await step('confirm', { time });
      else await sendWhatsAppText(admin, 'Escribe una hora futura en formato HH:MM, por ejemplo 17:30.');
    }
    return true;
  }
  const action = button[2];
  if (action === 'cancel' && draft.value !== 'saving') {
    const { data: removed } = await drafts().delete().eq('actor_phone', admin).eq('id', draft.id)
      .or('value.is.null,value.neq.saving').select('id').maybeSingle().throwOnError();
    if (removed) await sendWhatsAppText(admin, 'Pendiente descartado.');
    else await stale(admin);
  } else if (task.stage === 'reminder' && action === 'with') await step('date');
  else if (task.stage === 'reminder' && action === 'without') await step('confirm', { date: undefined, time: undefined });
  else if (task.stage === 'date' && action === 'another_date') await step('custom_date');
  else if (task.stage === 'date' && /^dates_[0-4]$/.test(action)) await showStep(admin, draft.id, task, Number(action.at(-1)));
  else if (task.stage === 'date' && action.startsWith('on_')) {
    const date = parseClinicDateInput(action.slice(3));
    if (date) await step('time', { date });
    else await showStep(admin, draft.id, task);
  } else if (task.stage === 'time' && action === 'another_time') await step('custom_time');
  else if (task.stage === 'time' && action === 'back_dates') await step('date');
  else if (task.stage === 'time' && /^times_[0-3]$/.test(action)) await showStep(admin, draft.id, task, Number(action.at(-1)));
  else if (task.stage === 'time' && action.startsWith('at_')) {
    const time = action.slice(3);
    if (formatTime(task.date, time)) await step('confirm', { time });
    else await showStep(admin, draft.id, task);
  } else if (task.stage === 'confirm' && action === 'change' && draft.value !== 'saving') await step('reminder');
  else if (task.stage === 'confirm' && action === 'save') await finishTaskDraft(admin, draft, task);
  else await stale(admin);
  return true;
}
