import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText, sendWhatsAppInteractiveList } from '@/lib/whatsapp';
import { getAppointmentsByDateRange, cancelCalendarEvent } from '@/lib/calendar';
import { generateEmbedding } from '@/lib/knowledge';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ADMIN_MODEL = 'gpt-4o-mini';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';

export const dynamic = 'force-dynamic';

const ADMIN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: { name: 'show_admin_menu', description: 'Muestra el menú interactivo con botones de ayuda para el administrador.', parameters: { type: 'object', properties: {} } }
  },
  {
    type: 'function',
    function: { name: 'change_bot_name', description: 'Actualiza el nombre del asistente virtual y/o el nombre de la clínica.', parameters: { type: 'object', properties: { new_name: { type: 'string' }, clinic_name: { type: 'string' } } } }
  },
  {
    type: 'function',
    function: { name: 'upsert_clinic_knowledge', description: 'Agrega FAQS, tratamientos y precios a la base de conocimientos.', parameters: { type: 'object', properties: { category: { type: 'string' }, content: { type: 'string' } }, required: ['category', 'content'] } }
  },
  {
    type: 'function',
    function: { name: 'get_today_schedule', description: 'Consulta la agenda en Google Calendar para buscar citas, pacientes o IDs.', parameters: { type: 'object', properties: { date_str: { type: 'string' } }, required: ['date_str'] } }
  },
  {
    type: 'function',
    function: { name: 'cancel_patient_appointments', description: 'Cancela citas usando sus eventIds invisibles.', parameters: { type: 'object', properties: { event_ids: { type: 'array', items: { type: 'string' } } }, required: ['event_ids'] } }
  },
  {
    type: 'function',
    function: { name: 'manage_clinic_tasks', description: 'Guarda o lee pendientes y recordatorios internos de la clínica.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'add'] }, task: { type: 'string' } }, required: ['action'] } }
  }
];

export async function runAdminAgent(payload: { from: string; content: string }): Promise<void> {
  const { from, content: text } = payload;
  
  try {
    const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    const fechaActual = new Date().toLocaleString('es-MX', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' });

    const systemPrompt = `Eres el asistente operativo interno. Usuario actual: Administrador.
Identidad: Bot "${settings?.bot_name || 'Asistente'}", clínica "${settings?.clinic_specialty || 'clínica'}". FECHA ACTUAL: ${fechaActual}.
    
REGLAS DE INTERACCIÓN (SÍGUELAS AL PIE DE LA LETRA):
1. MENÚ: Si escribe "Ayuda", "Menú" u "Opciones", ejecuta 'show_admin_menu'.
2. CANCELACIÓN DE CITAS (¡CRÍTICO!): NUNCA pidas el "eventId" ni códigos al administrador. Si pide cancelar a un paciente (ej. "Cancela a Magali"), TÚ DEBES ejecutar 'get_today_schedule' primero para buscar el eventId internamente, y una vez que el sistema te lo devuelva, ejecuta 'cancel_patient_appointments' de forma transparente.
3. TERMINAR CHAT: Si selecciona "Terminar chat directo", explícale textualmente: "Para cerrar la conversación y devolverle el control a la IA, desliza el último mensaje del paciente hacia la derecha (opción Responder) y escribe la palabra *Cerrar*". (No puedes cerrarlo tú porque necesitas saber a qué paciente específico se refiere).
4. IDENTIDAD: Si selecciona "Cambiar Identidad", pregúntale el nuevo nombre del bot y de la clínica y usa 'change_bot_name'.
5. RECORDATORIOS/TAREAS: Si selecciona "Pendientes/Recordat.", pregúntale qué desea anotar o si quiere ver sus pendientes, y usa 'manage_clinic_tasks'.
6. FAQ: Si elige "Agregar FAQ", pregúntale el dato y usa 'upsert_clinic_knowledge'.`;

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ];

    let finalReply = '';
    let hasSentUI = false;

    // Permitimos hasta 5 pasos para que la IA pueda encadenar herramientas (Buscar ID -> Cancelar ID)
    for (let step = 0; step < 5; step++) {
      const completion = await openai.chat.completions.create({ model: ADMIN_MODEL, temperature: 0.1, messages, tools: ADMIN_TOOLS, tool_choice: 'auto' });
      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) break;
      messages.push(assistantMessage);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
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
              to: from,
              bodyText: '🩺 *Panel de Administrador*\n¿En qué te puedo asistir hoy?',
              buttonText: 'Opciones de Admin',
              sections: [
                { title: 'Agenda', rows: [{ id: 'admin_agenda', title: 'Ver Citas de Hoy' }, { id: 'admin_cancelar', title: 'Cancelar Cita' }] },
                { title: 'Conocimientos y Tareas', rows: [{ id: 'admin_add_faq', title: 'Agregar FAQ' }, { id: 'admin_tasks', title: 'Pendientes/Recordat.' }] },
                { title: 'Configuración y Chat', rows: [{ id: 'admin_nombre_bot', title: 'Cambiar Identidad' }, { id: 'admin_cerrar_chat', title: 'Terminar chat directo' }] }
              ]
            });
            hasSentUI = true; output = 'Menú administrador enviado.';
          
          } else if (name === 'change_bot_name') {
            await supabase.from('bot_settings').update({ bot_name: args.new_name, clinic_specialty: args.clinic_name }).eq('id', 1);
            output = JSON.stringify({ success: true, message: 'Identidad actualizada exitosamente.' });
          
          } else if (name === 'upsert_clinic_knowledge') {
            const embedding = await generateEmbedding(args.content);
            await supabase.from('knowledge_base').insert({ category: args.category, content: args.content, embedding });
            output = JSON.stringify({ success: true, message: 'FAQ guardado.' });
          
          } else if (name === 'get_today_schedule') {
            const startIso = new Date(`${args.date_str}T00:00:00-06:00`).toISOString();
            const endIso = new Date(`${args.date_str}T23:59:59-06:00`).toISOString();
            const appointments = await getAppointmentsByDateRange(startIso, endIso);
            output = JSON.stringify(appointments.length ? appointments : { message: 'No hay citas registradas en esta fecha.' });
          
          } else if (name === 'cancel_patient_appointments') {
            for (const id of args.event_ids) await cancelCalendarEvent(id);
            output = JSON.stringify({ success: true, message: 'Citas canceladas en Calendar.' });
          
          } else if (name === 'manage_clinic_tasks') {
            if (args.action === 'add') {
              await supabase.from('clinic_tasks').insert({ description: args.task });
              output = JSON.stringify({ success: true, message: 'Recordatorio/Tarea guardada.' });
            } else {
              const { data } = await supabase.from('clinic_tasks').select('*').eq('is_completed', false).limit(10);
              output = JSON.stringify(data && data.length ? data : { message: 'No hay pendientes activos.' });
            }
          }
        } catch (err) { output = JSON.stringify({ error: String(err) }); }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
      }
    }
    
    if (!hasSentUI && finalReply) await sendWhatsAppText(from, finalReply);
  } catch (error) { console.error('[Admin Error]:', error); }
}