import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as db } from '@/lib/supabase';
import { findUpcomingAppointmentsByWhatsApp, getAppointmentsByDateRange, type CalendarEventData } from '@/lib/calendar';
import { clinicDate, clinicDayRange, formatAppointment, nextDate } from '@/lib/clinic-time';
import { proposeAppointmentAction } from '@/lib/appointment-actions';
import { addClinicTask, completeClinicTask, scheduleClinicTask, showPendingTasks } from '@/lib/clinic-tasks';
import { findCatalogEntries, normalized, showAdminMenu, showList, type Catalog } from '@/lib/menus';
import { visitStatusLabel } from '@/lib/reception';
import { parseClinicWhatsApp, sendWhatsAppInteractiveButtons, sendWhatsAppText } from '@/lib/whatsapp';

export async function showSchedule(phone: string, date = clinicDate(), events?: CalendarEventData[]) {
  const appointments = events ?? await getAppointmentsByDateRange(...clinicDayRange(date));
  const lines = appointments.slice(0, 25).map(event => {
    const state = event.visitStatus ? visitStatusLabel(event.visitStatus)
      : event.patientPhone ? event.attendanceConfirmed ? 'Asistencia confirmada' : 'Asistencia pendiente' : '';
    return `• ${formatAppointment(event.start)} — ${event.summary}${state ? ` · ${state}` : ''}`;
  });
  const text = `🗓️ *Agenda · ${date}*\n${lines.length ? lines.join('\n') : 'Sin citas programadas.'}${appointments.length > 25 ? `\nHay ${appointments.length - 25} citas adicionales en Calendar.` : ''}\n\nPara buscar por número, escribe «Buscar cita por WhatsApp» y el número completo.`;
  const today = clinicDate();
  if (text.length > 1024) await sendWhatsAppText(phone, text);
  const bodyText = text.length > 1024 ? 'Opciones de agenda' : text;
  if (date === today) {
    await showList(phone, bodyText, 'Ver opciones', [{ title: 'Recepción', rows: [
      { id: 'rec_visits_0', title: 'Registrar visita' },
      { id: 'rec_tomorrow', title: 'Mañana' },
      { id: 'admin_wait_queue_0', title: 'Lista de espera' },
      { id: 'admin_panel', title: 'Panel' },
    ] }], 'Escribe «Lista de espera», «Agenda de mañana» o «Ayuda».');
    return;
  }
  await sendWhatsAppInteractiveButtons({
    to: phone, bodyText,
    buttons: [
      { id: 'admin_agenda', title: 'Agenda de hoy' },
      ...(date !== nextDate(today) ? [{ id: 'rec_tomorrow', title: 'Mañana' }] : []),
      { id: 'admin_panel', title: 'Panel' },
    ],
  });
}

export async function showAppointmentsByWhatsApp(admin: string, input: string) {
  const phone = parseClinicWhatsApp(input);
  if (!phone) {
    await sendWhatsAppText(admin, 'Escribe «Buscar cita por WhatsApp» seguido del número completo. Usa 10 dígitos para México o incluye el código de país.');
    return;
  }
  const appointments = await findUpcomingAppointmentsByWhatsApp(phone);
  const lines = appointments.slice(0, 10).map(event => `• ${formatAppointment(event.start)} — ${event.summary}`);
  const remaining = appointments.length > 10 ? `\nHay ${appointments.length - 10} citas más para este número en Calendar.` : '';
  await sendWhatsAppText(admin, `🗓️ *Citas futuras · WhatsApp •••• ${phone.slice(-4)}*\n${lines.join('\n') || 'Sin citas futuras para ese número.'}${remaining}`);
}

const tools: ChatCompletionTool[] = [
  { type: 'function', function: {
    name: 'schedule', description: 'Consulta la agenda de un día. Usa get_clinic_date del contexto para hoy.',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['date'] },
  } },
  { type: 'function', function: {
    name: 'find_cancellation', description: 'Busca una cita futura por fecha, hora y/o paciente. Si hay una sola coincidencia, muestra opciones para corregir el WhatsApp o cancelar.',
    parameters: { type: 'object', properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' }, patient: { type: 'string' },
      time: { type: 'string', description: 'Hora local HH:MM' },
    }, required: ['date'] },
  } },
  { type: 'function', function: {
    name: 'manage_catalog', description: 'Lista, agrega, actualiza o retira un tratamiento o FAQ. Para editar o retirar, label es el nombre o pregunta existente.',
    parameters: { type: 'object', properties: {
      catalog: { type: 'string', enum: ['treatments', 'faqs'] }, action: { type: 'string', enum: ['list', 'add', 'update', 'delete'] },
      label: { type: 'string' }, new_label: { type: 'string' }, price: { type: 'number' }, answer: { type: 'string' },
      description: { type: 'string', description: 'Descripción del tratamiento para la ficha, proporcionada por la clínica.' },
    }, required: ['catalog', 'action'] },
  } },
  { type: 'function', function: {
    name: 'add_task', description: 'Anota un pendiente interno nuevo, con recordatorio si fue pedido. La fecha y la hora son de la clínica.',
    parameters: { type: 'object', properties: {
      description: { type: 'string' }, reminder_requested: { type: 'boolean' },
      date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM, 24 horas' },
    }, required: ['description', 'reminder_requested'] },
  } },
  { type: 'function', function: {
    name: 'schedule_task_reminder', description: 'Programa o cambia el recordatorio de un pendiente abierto cuando el administrador proporciona su número, fecha y hora.',
    parameters: { type: 'object', properties: {
      id: { type: 'integer' }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM, 24 horas' },
    }, required: ['id', 'date', 'time'] },
  } },
  { type: 'function', function: {
    name: 'list_tasks', description: 'Muestra pendientes abiertos y sus recordatorios.',
    parameters: { type: 'object', properties: {} },
  } },
  { type: 'function', function: {
    name: 'complete_task', description: 'Marca un pendiente como completado únicamente cuando el administrador pide cerrarlo e indica el número.',
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  } },
];

type CatalogRequest = { catalog: Catalog; action: string; label?: string; new_label?: string; price?: number; answer?: string; description?: string };

async function manageCatalog(args: CatalogRequest) {
  const { catalog, action } = args;
  if (catalog !== 'treatments' && catalog !== 'faqs') return 'Elige un catálogo válido.';
  const treatments = catalog === 'treatments';
  const field = treatments ? 'name' : 'question';
  if (action === 'list') {
    const { data } = await db.from(catalog).select('*').eq('is_active', true).order('id').limit(25).throwOnError();
    return data ?? [];
  }
  const label = args.label?.trim();
  if (!label || label.length > 250) return 'Especifica el nombre o la pregunta.';
  const priceValid = typeof args.price === 'number' && Number.isFinite(args.price) && args.price >= 0;
  const answer = args.answer?.trim();
  const description = args.description?.trim();
  if (treatments && description && description.length > 600) return 'Escribe una descripción de hasta 600 caracteres.';
  const newLabel = args.new_label?.trim();
  if (action === 'add') {
    if (treatments && !priceValid) return 'Indica un precio válido en MXN.';
    if (!treatments && !answer) return 'Indica la respuesta de la pregunta.';
    const values: Record<string, unknown> = treatments ? { name: label, price: args.price, description: description || null } : { question: label, answer };
    const existing = await findCatalogEntries(catalog, label);
    if (existing.some(item => normalized(item.label) === normalized(label))) return 'Ya existe una opción activa con ese nombre.';
    await db.from(catalog).insert(values).throwOnError();
    return 'Opción guardada.';
  }
  if (action !== 'update' && action !== 'delete') return 'Acción desconocida.';
  const entries = await findCatalogEntries(catalog, label);
  if (entries.length !== 1) return { mensaje: 'Identifica una sola opción.', coincidencias: entries.map(item => item.label) };
  const changes: Record<string, unknown> = {};
  if (action === 'delete') changes.is_active = false;
  else {
    if (newLabel && newLabel.length <= 250) changes[field] = newLabel;
    if (treatments && priceValid) changes.price = args.price;
    if (treatments && description) changes.description = description;
    if (!treatments && answer) changes.answer = answer;
  }
  if (!Object.keys(changes).length) return 'Faltan datos válidos para el cambio.';
  const { data } = await db.from(catalog).update(changes).eq('id', entries[0].id).eq('is_active', true).select('id').maybeSingle().throwOnError();
  return data ? (action === 'delete' ? 'Opción retirada del catálogo.' : 'Opción actualizada.') : 'La opción ya no está activa.';
}

export async function runAdminAgent(from: string, content: string) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 12_000, maxRetries: 0 });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: `Eres Benson, el asistente operativo interno. En la clínica hoy es ${clinicDate()} y la hora local es ${formatAppointment(new Date().toISOString())}.
Usa las herramientas para consultar agenda, corregir el WhatsApp de una cita, preparar cancelaciones, gestionar tratamientos y FAQs y anotar, mostrar o completar pendientes. Solo modifica registros a petición explícita. Para programar un recordatorio, usa el día y la hora que pidió el administrador, interpretados en la zona horaria local. Si falta el día, la hora o el número de un pendiente existente, pide ese dato en un solo mensaje y no inventes valores. Si quiere ver la lista, usa list_tasks. Para corregir el WhatsApp de una cita o cancelarla, usa find_cancellation. Pide fecha y nombre u hora si faltan, nunca el ID. Si hay varias coincidencias, muestra sus horarios y pide el nombre y horario en un mismo mensaje. La acción elegida en WhatsApp confirma el cambio. Comunica errores o datos faltantes sin declarar acciones completadas antes de su resultado. Responde breve, en español.` },
    { role: 'user', content },
  ];
  for (let turn = 0; turn < 4; turn++) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', temperature: 0.1, messages, tools, parallel_tool_calls: false,
    });
    const message = response.choices[0]?.message;
    if (!message) break;
    messages.push(message);
    if (!message.tool_calls?.length) {
      await sendWhatsAppText(from, message.content || 'Escribe «Ayuda» para ver el panel.');
      return;
    }
    for (const tool of message.tool_calls) {
      if (tool.type !== 'function') continue;
      const name = tool.function.name;
      const args = JSON.parse(tool.function.arguments);
      let result: unknown = 'Acción desconocida';
      if (name === 'schedule') {
        await showSchedule(from, args.date || clinicDate());
        return;
      }
      if (name === 'find_cancellation') {
        const date = args.date as string;
        const patient = typeof args.patient === 'string' ? normalized(args.patient) : '';
        const time = typeof args.time === 'string' ? args.time : '';
        if (!date || (!patient && !time)) result = 'Falta la fecha y el nombre u hora.';
        else {
          const formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: process.env.CLINIC_TIMEZONE || 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
          });
          const matches = (await getAppointmentsByDateRange(...clinicDayRange(date))).filter(event =>
            Date.parse(event.start) > Date.now()
            && (!patient || normalized(event.summary).includes(patient))
            && (!time || formatter.format(new Date(event.start)) === time),
          );
          if (matches.length === 1) {
            await proposeAppointmentAction(from, { action: 'cancel_clinic', details: matches[0] });
            return;
          }
          result = { coincidencias: matches.slice(0, 10).map(event => `${event.summary} — ${formatAppointment(event.start)}`) };
        }
      }
      if (name === 'manage_catalog') result = await manageCatalog(args);
      if (name === 'list_tasks') return showPendingTasks(from);
      if (name === 'add_task') return void await sendWhatsAppText(from, await addClinicTask(args));
      if (name === 'schedule_task_reminder') return void await sendWhatsAppText(from, await scheduleClinicTask(args.id, args.date, args.time));
      if (name === 'complete_task') return void await sendWhatsAppText(from, await completeClinicTask(args.id));
      messages.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify(result) });
    }
  }
  await showAdminMenu(from);
}
