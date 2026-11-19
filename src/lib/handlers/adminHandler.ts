import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText } from '@/lib/whatsapp';
import { getAppointmentsByDateRange, cancelCalendarEvent } from '@/lib/calendar';
import { generateEmbedding } from '@/lib/knowledge';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ADMIN_MODEL = 'gpt-4o-mini';

const ADMIN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'change_bot_name',
      description: 'Actualiza el nombre del asistente virtual y/o el nombre de la clínica en la base de datos.',
      parameters: { type: 'object', properties: { new_name: { type: 'string' }, clinic_name: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upsert_clinic_knowledge',
      description: 'Agrega FAQS, tratamientos y precios a la base de conocimientos.',
      parameters: { type: 'object', properties: { category: { type: 'string' }, content: { type: 'string' } }, required: ['category', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_today_schedule',
      description: 'Consulta la agenda en Google Calendar. EXIGE UNA FECHA YYYY-MM-DD.',
      parameters: { type: 'object', properties: { date_str: { type: 'string' } }, required: ['date_str'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_patient_appointments',
      description: 'Cancela citas usando sus eventIds.',
      parameters: { type: 'object', properties: { event_ids: { type: 'array', items: { type: 'string' } } }, required: ['event_ids'] }
    }
  }
];

export async function runAdminAgent(payload: { from: string; content: string }): Promise<void> {
  const { from, content: text } = payload;
  
  try {
    // 1. Obtener la configuración actual para que el Admin sepa su propia identidad
    const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();

    const systemPrompt = `Eres el asistente operativo interno de la clínica. El usuario es tu jefe/administrador.
    Identidad actual pública: Bot se llama "${settings?.bot_name || 'Asistente Clínico'}" y la clínica es "${settings?.clinic_specialty || 'la clínica'}".
    REGLAS:
    - Si te piden cambiar tu nombre o el de la clínica, DEBES ejecutar 'change_bot_name'.
    - Si te piden agregar una pregunta frecuente (FAQ), DEBES ejecutar 'upsert_clinic_knowledge'.
    - Si te piden revisar la agenda, usa 'get_today_schedule', lee los resultados que te devuelva el sistema y dáselos al administrador. No inventes que fue exitoso sin mostrar los datos.`;

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ];

    let finalReply = '';

    for (let step = 0; step < 4; step++) {
      const completion = await openai.chat.completions.create({ model: ADMIN_MODEL, messages, tools: ADMIN_TOOLS, tool_choice: 'auto' });
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
          // --- AQUÍ ESTABA EL ERROR: AHORA SÍ CONECTAMOS CADA FUNCIÓN A LA BASE DE DATOS Y CALENDARIO ---
          if (name === 'change_bot_name') {
            await supabase.from('bot_settings').update({
              bot_name: args.new_name || settings?.bot_name,
              clinic_specialty: args.clinic_name || settings?.clinic_specialty
            }).eq('id', 1);
            output = JSON.stringify({ success: true, message: 'Nombres actualizados correctamente en la base de datos de Supabase.' });
          
          } else if (name === 'upsert_clinic_knowledge') {
            const embedding = await generateEmbedding(args.content);
            await supabase.from('knowledge_base').insert({ category: args.category, content: args.content, embedding });
            output = JSON.stringify({ success: true, message: 'La información se guardó correctamente en Supabase.' });
          
          } else if (name === 'get_today_schedule') {
            // Buscamos desde las 00:00 hasta las 23:59 del día solicitado
            const startIso = new Date(`${args.date_str}T00:00:00-06:00`).toISOString();
            const endIso = new Date(`${args.date_str}T23:59:59-06:00`).toISOString();
            const appointments = await getAppointmentsByDateRange(startIso, endIso);
            output = JSON.stringify(appointments.length ? appointments : { message: 'No hay citas registradas en Google Calendar para esta fecha.' });
          
          } else if (name === 'cancel_patient_appointments') {
            for (const id of args.event_ids) {
              await cancelCalendarEvent(id);
            }
            output = JSON.stringify({ success: true, message: 'Citas canceladas en Google Calendar.' });
          } else {
            output = JSON.stringify({ error: 'Herramienta no implementada.' });
          }
        } catch (err) {
          output = JSON.stringify({ error: String(err) });
        }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
      }
    }
    await sendWhatsAppText(from, finalReply || 'Listo.');
  } catch (error) {
    console.error('[Admin Handler Error]:', error);
  }
}