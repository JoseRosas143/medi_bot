import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText, sendWhatsAppInteractiveList } from '@/lib/whatsapp';
import { getAppointmentsByDateRange, cancelCalendarEvent } from '@/lib/calendar';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ADMIN_MODEL = 'gpt-4o-mini';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';
export const dynamic = 'force-dynamic';

const ADMIN_TOOLS: ChatCompletionTool[] = [
  { type: 'function', function: { name: 'show_admin_menu', description: 'Muestra el panel interactivo de administración.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_today_schedule', description: 'Consulta Google Calendar para buscar citas o extraer eventIds ocultos.', parameters: { type: 'object', properties: { date_str: { type: 'string' } }, required: ['date_str'] } } },
  { type: 'function', function: { name: 'cancel_patient_appointments', description: 'Cancela citas definitivamente usando sus eventIds.', parameters: { type: 'object', properties: { event_ids: { type: 'array', items: { type: 'string' } } }, required: ['event_ids'] } } },
  { type: 'function', function: { name: 'manage_treatments', description: 'Gestiona la tabla exacta de tratamientos.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'update', 'delete', 'list'] }, name: { type: 'string' }, price: { type: 'number' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'manage_faqs', description: 'Gestiona la tabla exacta de FAQs.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'update', 'delete', 'list'] }, question: { type: 'string' }, answer: { type: 'string' } }, required: ['action'] } } }
];

export async function runAdminAgent(payload: { from: string; content: string }): Promise<void> {
  const { from, content: text } = payload;
  try {
    const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    const fechaActual = new Date().toLocaleString('es-MX', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' });

    const systemPrompt = `Eres el asistente operativo interno. Usuario actual: Administrador. Fecha: ${fechaActual}.
REGLAS ESTRICTAS Y PERMISOS:
1. Eres el administrador del sistema. TIENES PERMISOS TOTALES.
2. MENÚ: Si escribe "Ayuda", "Menú" u "Opciones", ejecuta 'show_admin_menu'.
3. TRATAMIENTOS: Si pide agregar, cambiar o borrar un Tratamiento, usa 'manage_treatments' de forma silenciosa e infórmalo.
4. FAQS/POLÍTICAS: Si pide agregar, editar o eliminar información/FAQs, usa 'manage_faqs'.
5. CANCELAR CITAS (CRÍTICO): Si pide cancelar una cita, haz dos pasos seguidos de forma invisible: ejecuta 'get_today_schedule' para buscar el evento, extrae su 'eventId', y ejecuta 'cancel_patient_appointments'. Eres 100% capaz de hacerlo.`;

    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];
    let finalReply = '';
    let hasSentUI = false;

    for (let step = 0; step < 5; step++) {
      const completion = await openai.chat.completions.create({ model: ADMIN_MODEL, temperature: 0.1, messages, tools: ADMIN_TOOLS, tool_choice: 'auto' });
      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) break;
      messages.push(assistantMessage);

      if (!assistantMessage.tool_calls?.length) {
        finalReply = assistantMessage.content || 'Completado.';
        break;
      }

      for (const toolCall of assistantMessage.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        let output = '';

        try {
          if (name === 'show_admin_menu') {
            await sendWhatsAppInteractiveList({
              to: from, bodyText: '🩺 *Panel de Administrador*\n¿En qué te puedo asistir hoy?', buttonText: 'Abrir Panel',
              sections: [
                { title: 'Base de Datos (Tratamientos)', rows: [{ id: 'adm_add_treatment', title: 'Agregar Tratamiento' }, { id: 'adm_edit_treatment', title: 'Editar/Borrar Trat.' }] },
                { title: 'Base de Datos (Info/FAQs)', rows: [{ id: 'adm_add_faq', title: 'Agregar Info/FAQ' }, { id: 'adm_edit_faq', title: 'Editar/Borrar FAQ' }] },
                { title: 'Agenda y Chat', rows: [{ id: 'admin_agenda', title: 'Ver Citas de Hoy' }, { id: 'admin_cancelar', title: 'Cancelar Cita' }, { id: 'admin_cerrar_chat', title: 'Terminar chat directo' }] }
              ]
            });
            hasSentUI = true; output = 'Menú enviado.';
          } else if (name === 'manage_treatments') {
            if (args.action === 'list') {
              const { data } = await supabase.from('treatments').select('*').eq('is_active', true);
              output = JSON.stringify(data || []);
            } else if (args.action === 'add') {
              await supabase.from('treatments').insert({ name: args.name, price: args.price }); output = 'Tratamiento guardado en BD.';
            } else if (args.action === 'update') {
              await supabase.from('treatments').update({ price: args.price }).ilike('name', `%${args.name}%`); output = 'Precio actualizado en BD.';
            } else if (args.action === 'delete') {
              await supabase.from('treatments').delete().ilike('name', `%${args.name}%`); output = 'Tratamiento eliminado de BD.';
            }
          } else if (name === 'manage_faqs') {
            if (args.action === 'list') {
              const { data } = await supabase.from('faqs').select('*').eq('is_active', true);
              output = JSON.stringify(data || []);
            } else if (args.action === 'add') {
              await supabase.from('faqs').insert({ question: args.question, answer: args.answer }); output = 'FAQ guardado en BD.';
            } else if (args.action === 'update') {
              await supabase.from('faqs').update({ answer: args.answer }).ilike('question', `%${args.question}%`); output = 'FAQ actualizado.';
            } else if (args.action === 'delete') {
              await supabase.from('faqs').delete().ilike('question', `%${args.question}%`); output = 'FAQ eliminado.';
            }
          } else if (name === 'get_today_schedule') {
            const startIso = new Date(`${args.date_str}T00:00:00-06:00`).toISOString();
            const endIso = new Date(`${args.date_str}T23:59:59-06:00`).toISOString();
            const appts = await getAppointmentsByDateRange(startIso, endIso);
            output = JSON.stringify(appts.length ? appts : { message: 'No hay citas en esta fecha.' });
          } else if (name === 'cancel_patient_appointments') {
            for (const id of args.event_ids) {
              await cancelCalendarEvent(id);
            }
            output = 'Citas canceladas exitosamente en Google Calendar.';
          }
        } catch (err) { output = JSON.stringify({ error: String(err) }); }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
      }
    }
    if (!hasSentUI && finalReply) await sendWhatsAppText(from, finalReply);
  } catch (error) { console.error('[Admin Error]:', error); }
}