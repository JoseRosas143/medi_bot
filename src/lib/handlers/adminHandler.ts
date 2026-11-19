import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as db } from '@/lib/supabase';
import { getAppointmentsByDateRange, type CalendarEventData } from '@/lib/calendar';
import { clinicDate, clinicDayRange, formatAppointment } from '@/lib/clinic-time';
import { proposeAppointmentAction } from '@/lib/appointment-actions';
import { findCatalogEntries, normalized, showAdminMenu, type Catalog } from '@/lib/menus';
import { sendWhatsAppText } from '@/lib/whatsapp';

export async function showSchedule(phone: string, date = clinicDate(), events?: CalendarEventData[]) {
  const appointments = events ?? await getAppointmentsByDateRange(...clinicDayRange(date));
  const lines = appointments.slice(0, 25).map(event => `• ${formatAppointment(event.start)} — ${event.summary}`);
  await sendWhatsAppText(phone, `🗓️ *Agenda · ${date}*\n${lines.length ? lines.join('\n') : 'Sin citas programadas.'}${appointments.length > 25 ? `\nHay ${appointments.length - 25} citas adicionales en Calendar.` : ''}`);
}

const tools: ChatCompletionTool[] = [
  { type: 'function', function: {
    name: 'schedule', description: 'Consulta la agenda de un día. Usa get_clinic_date del contexto para hoy.',
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['date'] },
  } },
  { type: 'function', function: {
    name: 'find_cancellation', description: 'Busca cita futura por fecha, hora y/o paciente. Prepara un botón si hay una sola coincidencia.',
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
    }, required: ['catalog', 'action'] },
  } },
  { type: 'function', function: {
    name: 'add_task', description: 'Anota un pendiente interno solicitado por el administrador.',
    parameters: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
  } },
];

type CatalogRequest = { catalog: Catalog; action: string; label?: string; new_label?: string; price?: number; answer?: string };

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
  const newLabel = args.new_label?.trim();
  if (action === 'add') {
    if (treatments && !priceValid) return 'Indica un precio válido en MXN.';
    if (!treatments && !answer) return 'Indica la respuesta de la pregunta.';
    const values: Record<string, unknown> = treatments ? { name: label, price: args.price } : { question: label, answer };
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
    if (!treatments && answer) changes.answer = answer;
  }
  if (!Object.keys(changes).length) return 'Faltan datos válidos para el cambio.';
  const { data } = await db.from(catalog).update(changes).eq('id', entries[0].id).eq('is_active', true).select('id').maybeSingle().throwOnError();
  return data ? (action === 'delete' ? 'Opción retirada del catálogo.' : 'Opción actualizada.') : 'La opción ya no está activa.';
}

export async function runAdminAgent(from: string, content: string) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 12_000, maxRetries: 0 });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: `Eres Benson, el asistente operativo interno. En la clínica hoy es ${clinicDate()}.
Usa las herramientas para consultar agenda, preparar cancelaciones, gestionar tratamientos y FAQs y anotar pendientes. Solo modifica registros a petición explícita. Para cancelar pide fecha y nombre u hora, nunca el ID. Si hay varias coincidencias, muestra sus horarios y pide el nombre y horario en un mismo mensaje. El botón confirma la cancelación. Comunica errores o datos faltantes sin declarar acciones completadas antes de su resultado. Responde breve, en español.` },
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
      if (name === 'add_task') {
        const description = typeof args.description === 'string' ? args.description.trim() : '';
        if (!description || description.length > 1500) result = 'Indica el pendiente en un mensaje breve.';
        else {
          await db.from('clinic_tasks').insert({ description }).throwOnError();
          result = 'Pendiente guardado.';
        }
      }
      messages.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify(result) });
    }
  }
  await showAdminMenu(from);
}
