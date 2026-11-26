import { supabaseAdmin as db } from '@/lib/supabase';
import { clinicInstant, formatAppointment } from '@/lib/clinic-time';
import { showList } from '@/lib/menus';
import {
  isWhatsAppPhone, phoneDigits, sendWhatsAppInteractiveButtons, sendWhatsAppTemplate, sendWhatsAppText, shorten, WhatsAppError,
} from '@/lib/whatsapp';

type ReminderState = 'scheduled' | 'sending' | 'accepted' | 'delivered' | 'rejected' | 'failed' | 'uncertain';
type ClinicTask = { id: number; description: string; reminder_at: string | null; reminder_state: ReminderState | null };
const taskColumns = 'id,description,reminder_at,reminder_state';
const pageSize = 5;
const tasks = () => db.from('clinic_tasks');

const reminderLabels: Record<ReminderState, string> = {
  scheduled: 'Programado', sending: 'Enviando', accepted: 'Aceptado por WhatsApp',
  delivered: 'Entregado', rejected: 'Rechazado por WhatsApp',
  failed: 'Entrega fallida', uncertain: 'Sin confirmación de envío',
};

function validTaskId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= 2_147_483_647;
}

function scheduledAt(date: unknown, time: unknown) {
  if (typeof date !== 'string' || typeof time !== 'string') return null;
  try {
    const at = clinicInstant(date, time);
    return at.getTime() > Date.now() ? at.toISOString() : null;
  } catch {
    return null;
  }
}

async function pendingReminderSettings() {
  const phone = phoneDigits(process.env.ADMIN_PHONE_NUMBER);
  if (!isWhatsAppPhone(phone)) return null;
  const override = process.env.WHATSAPP_TASK_REMINDER_TEMPLATE?.trim();
  if (override) return { phone, template: override };
  const { data } = await db.from('bot_settings').select('task_reminder_template').eq('id', 1).maybeSingle().throwOnError();
  const template = data?.task_reminder_template?.trim();
  return template ? { phone, template } : null;
}

function taskReminder(task: ClinicTask, sendingEnabled: boolean) {
  if (!task.reminder_at || !task.reminder_state) return 'Sin recordatorio';
  const label = task.reminder_state === 'scheduled' && !sendingEnabled
    ? 'Programado · envío pendiente de activación'
    : reminderLabels[task.reminder_state];
  return `${label} · ${formatAppointment(task.reminder_at)}`;
}

export async function showPendingTasks(phone: string, page = 0, removing = false) {
  const offset = page * pageSize;
  const { data } = await tasks().select(taskColumns).eq('is_completed', false)
    .order('id', { ascending: false }).range(offset, offset + pageSize).throwOnError();
  const rows = (data ?? []) as ClinicTask[];
  if (!rows.length && page === 0) {
    await sendWhatsAppInteractiveButtons({ to: phone, bodyText: '📋 No hay pendientes abiertos.', buttons: [
      { id: 'admin_task', title: 'Anotar pendiente' }, { id: 'admin_panel', title: 'Volver al panel' },
    ] });
    return;
  }
  const sendingEnabled = Boolean(rows.some(task => task.reminder_state === 'scheduled') && await pendingReminderSettings());
  const selectable = rows.slice(0, pageSize).map(task => ({
    id: `admin_task_${removing ? 'review_remove' : 'view'}_${task.id}`,
    title: `#${task.id} ${task.description.replace(/\s+/g, ' ')}`,
    description: taskReminder(task, sendingEnabled),
  }));
  const prefix = removing ? 'admin_tasks_remove_' : 'admin_tasks_';
  const title = removing ? '¿Qué pendiente quieres borrar?' : 'Pendientes abiertos';
  await showList(phone, `📋 *${title}*\n${selectable.length
    ? removing ? 'Elige uno para revisar y confirmar.' : 'Selecciona un pendiente para ver su detalle.'
    : 'Esta página ya no tiene pendientes.'}`, 'Ver pendientes', [
    ...(selectable.length ? [{ title: 'Pendientes', rows: selectable }] : []),
    { title: 'Navegación', rows: [
      ...(page > 0 ? [{ id: prefix + (page - 1), title: 'Anterior' }] : []),
      ...(rows.length > pageSize ? [{ id: prefix + (page + 1), title: 'Siguiente' }] : []),
      ...(removing ? [{ id: 'admin_tasks_0', title: 'Volver a pendientes' }] : [
        { id: 'admin_task', title: 'Anotar pendiente' },
        { id: 'admin_tasks_remove_0', title: 'Borrar pendientes' },
        { id: 'admin_panel', title: 'Volver al panel' },
      ]),
    ] },
  ], 'Escribe «Pendiente #» seguido de su número para abrir el detalle.');
}

export async function showClinicTask(phone: string, id: number) {
  if (!validTaskId(id)) return sendWhatsAppText(phone, 'Indica el número del pendiente.');
  const { data } = await tasks().select(taskColumns).eq('id', id).eq('is_completed', false).maybeSingle().throwOnError();
  if (!data) return sendWhatsAppText(phone, 'No encontré ese pendiente abierto. Escribe «Pendientes» para ver la lista.');
  const task = data as ClinicTask;
  const sendingEnabled = Boolean(task.reminder_state === 'scheduled' && await pendingReminderSettings());
  const title = `📋 *Pendiente #${id}*`;
  const detail = `${title}\n${task.description}\n\n${taskReminder(task, sendingEnabled)}\n\nPara agendar un aviso, escribe «Recuérdame el pendiente #${id} mañana a las 9:00».`;
  if (detail.length > 1024) await sendWhatsAppText(phone, detail);
  return sendWhatsAppInteractiveButtons({ to: phone, bodyText: detail.length <= 1024 ? detail : title,
    buttons: [
      { id: `admin_task_review_remove_${id}`, title: 'Borrar pendiente' },
      { id: 'admin_tasks_0', title: 'Volver a pendientes' },
    ],
  });
}

function scheduleFields(at: string) {
  return { reminder_at: at, reminder_state: 'scheduled', reminder_attempted_at: null, reminder_message_id: null };
}

async function savedTaskMessage(task: ClinicTask) {
  if (!task.reminder_at) return `✅ Pendiente #${task.id} guardado. Escribe «Pendientes» para verlo.`;
  const status = await pendingReminderSettings()
    ? 'El cron intentará enviar el aviso en la primera ejecución posterior a esa hora.'
    : 'El aviso se guardó y queda pendiente de activar el envío de WhatsApp.';
  return `✅ Pendiente #${task.id} con aviso para ${formatAppointment(task.reminder_at)}.\n${status}`;
}

const invalidSchedule = 'Envía el pendiente y una fecha y hora futuras en el mismo mensaje. Usa la hora local de la clínica.';

export async function addClinicTask(args: { description?: unknown; reminder_requested?: unknown; date?: unknown; time?: unknown }, creationToken?: string) {
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  if (!description || description.length > 1500) return 'Indica el pendiente en un mensaje de hasta 1,500 caracteres.';
  const at = scheduledAt(args.date, args.time);
  if ((args.reminder_requested === true || args.date || args.time) && !at) return invalidSchedule;
  const { data, error } = await tasks().insert({
    description, ...(at ? scheduleFields(at) : {}), ...(creationToken ? { creation_token: creationToken } : {}),
  }).select(taskColumns).single();
  if (error?.code === '23505' && creationToken) {
    const { data: existing } = await tasks().select(taskColumns).eq('creation_token', creationToken).single().throwOnError();
    return savedTaskMessage(existing as ClinicTask);
  }
  if (error) throw error;
  return savedTaskMessage(data as ClinicTask);
}

export async function scheduleClinicTask(id: unknown, date: unknown, time: unknown) {
  if (!validTaskId(id)) return 'Indica el número. Escribe «Pendientes» para encontrarlo.';
  const at = scheduledAt(date, time);
  if (!at) return invalidSchedule;
  const { data } = await tasks().update(scheduleFields(at)).eq('id', id).eq('is_completed', false)
    .or('reminder_state.is.null,reminder_state.neq.sending').select(taskColumns).maybeSingle().throwOnError();
  return data ? savedTaskMessage(data as ClinicTask)
    : 'El pendiente no está abierto o su aviso está en proceso de envío. Revisa «Pendientes».';
}

export async function completeClinicTask(id: unknown, removed = false) {
  if (!validTaskId(id)) return 'Indica el número. Escribe «Pendientes» para encontrarlo.';
  const { data } = await tasks().update({ is_completed: true }).eq('id', id).eq('is_completed', false)
    .or('reminder_state.is.null,reminder_state.neq.sending').select('id').maybeSingle().throwOnError();
  return data ? `✅ Pendiente #${id} ${removed ? 'retirado de la lista' : 'completado'}.`
    : 'El pendiente ya no está abierto o su aviso está en proceso de envío. Revisa «Pendientes».';
}

export async function handleTaskButtons(phone: string, option?: string) {
  const match = option?.match(/^admin_task_(view|review_remove|remove)_(\d{1,10})$/);
  if (!match || !validTaskId(Number(match[2]))) return false;
  const [, action, token] = match;
  const id = Number(token);
  const back = { id: 'admin_tasks_0', title: 'Volver a pendientes' };
  if (action === 'view') await showClinicTask(phone, id);
  else if (action === 'remove') {
    await sendWhatsAppInteractiveButtons({ to: phone, bodyText: await completeClinicTask(id, true), buttons: [
      { id: 'admin_tasks_remove_0', title: 'Borrar otro' }, back,
    ] });
  } else {
    const { data } = await tasks().select('description').eq('id', id).eq('is_completed', false).maybeSingle().throwOnError();
    if (!data) await sendWhatsAppInteractiveButtons({ to: phone, bodyText: 'Ese pendiente ya no está abierto.', buttons: [back] });
    else await sendWhatsAppInteractiveButtons({ to: phone,
      bodyText: `*¿Borrar pendiente #${id}?*\n${shorten(data.description, 500)}\n\nSe retirará de la lista y se cancelará su recordatorio si aún está programado.`,
      buttons: [{ id: `admin_task_remove_${id}`, title: 'Sí, borrar' }, back],
    });
  }
  return true;
}

export async function runClinicTaskReminders(now = new Date()) {
  const settings = await pendingReminderSettings();
  if (!settings) return { enabled: false, counts: {} as Record<string, number> };
  const time = now.toISOString();
  await tasks().update({ reminder_state: 'uncertain' }).eq('reminder_state', 'sending')
    .lt('reminder_attempted_at', new Date(now.getTime() - 10 * 60_000).toISOString()).throwOnError();
  const { data } = await tasks().select('id,reminder_at').eq('is_completed', false)
    .eq('reminder_state', 'scheduled').lte('reminder_at', time).order('reminder_at').limit(10).throwOnError();
  const counts: Record<string, number> = {};
  const rows = data ?? [];
  for (let index = 0; index < rows.length; index += 5) {
    const results = await Promise.allSettled(rows.slice(index, index + 5).map(async task => {
      const { data: claimed } = await tasks().update({ reminder_state: 'sending', reminder_attempted_at: time })
        .eq('id', task.id).eq('is_completed', false).eq('reminder_at', task.reminder_at)
        .eq('reminder_state', 'scheduled').select('id').maybeSingle().throwOnError();
      if (!claimed) return 'skipped';
      let state: ReminderState;
      let messageId: string | null = null;
      try {
        messageId = await sendWhatsAppTemplate(settings.phone, settings.template, [String(task.id)]);
        state = 'accepted';
      } catch (error) {
        state = error instanceof WhatsAppError && error.status < 500 ? 'rejected' : 'uncertain';
      }
      await tasks().update({ reminder_state: state, reminder_message_id: messageId })
        .eq('id', task.id).eq('reminder_state', 'sending').eq('reminder_attempted_at', time).throwOnError();
      return state;
    }));
    for (const result of results) {
      const status = result.status === 'fulfilled' ? result.value : 'error';
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }
  return { enabled: true, counts };
}

export async function recordTaskReminderStatus(id: string, status: 'failed' | 'delivered' | 'read') {
  await tasks().update({ reminder_state: status === 'failed' ? 'failed' : 'delivered' })
    .eq('reminder_message_id', id).in('reminder_state', ['accepted', 'uncertain']).throwOnError();
}
