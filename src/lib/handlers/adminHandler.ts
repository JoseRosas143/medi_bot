import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText } from '@/lib/whatsapp';
import { getAppointmentsByDateRange, cancelCalendarEvent } from '@/lib/calendar';
import { generateEmbedding } from '@/lib/knowledge';
import type { IncomingMessage } from '@/lib/message-handlers';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ADMIN_MODEL = 'gpt-4o-mini';

const ADMIN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'change_bot_name',
      description: 'Actualiza el nombre del asistente virtual y/o el nombre de la clínica.',
      parameters: { type: 'object', properties: { new_name: { type: 'string' }, clinic_name: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upsert_clinic_knowledge',
      description: 'Agrega o actualiza FAQS, tratamientos, políticas y precios en la base de conocimientos (RAG).',
      parameters: { type: 'object', properties: { category: { type: 'string', enum: ['precios', 'horarios', 'servicios', 'faq', 'ubicacion'] }, content: { type: 'string' } }, required: ['category', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_promo_or_review_request',
      description: 'Envía un mensaje de texto (ej. pedir reseña de Google Maps o promoción) a un número de paciente específico.',
      parameters: { type: 'object', properties: { phone: { type: 'string' }, message: { type: 'string' } }, required: ['phone', 'message'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_today_schedule',
      description: 'Consulta la agenda de citas en Google Calendar para una fecha YYYY-MM-DD.',
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

export async function runAdminAgent(payload: IncomingMessage): Promise<void> {
  const { from, content: text } = payload;
  
  try {
    const systemPrompt = `Eres el asistente operativo interno de la clínica. El usuario es tu jefe/administrador.
    Usa 'upsert_clinic_knowledge' para crear FAQs o información de tratamientos que leerán los pacientes.
    Usa 'send_promo_or_review_request' para enviar un texto pidiendo reviews.`;

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
        if (toolCall.type !== 'function') continue; // <-- Corrección TypeScript

        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        let output = '';

        if (name === 'upsert_clinic_knowledge') {
          const embedding = await generateEmbedding(args.content);
          await supabase.from('knowledge_base').insert({ category: args.category, content: args.content, embedding });
          output = JSON.stringify({ success: true, message: 'Información indexada en la IA de pacientes.' });
        } 
        else if (name === 'send_promo_or_review_request') {
          await sendWhatsAppText(args.phone, args.message);
          output = JSON.stringify({ success: true, message: 'Mensaje enviado al paciente.' });
        }
        else {
          output = JSON.stringify({ success: true });
        }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
      }
    }
    await sendWhatsAppText(from, finalReply || 'Listo.');
  } catch (error) {
    console.error(error);
  }
}