import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText, sendWhatsAppInteractiveList, sendWhatsAppInteractiveButtons } from '@/lib/whatsapp';
import { searchKnowledge } from '@/lib/knowledge';
import { getAvailableSlots, createCalendarAppointment, getPatientAppointments, cancelCalendarEvent } from '@/lib/calendar';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PATIENT_MODEL = 'gpt-4o-mini';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';

// Bloqueo para evitar que Vercel cachee la fecha 
export const dynamic = 'force-dynamic';

const PATIENT_TOOLS: ChatCompletionTool[] = [
  { type: 'function', function: { name: 'show_interactive_menu', description: 'Muestra el menú visual.', parameters: { type: 'object', properties: { greeting_text: { type: 'string' } }, required: ['greeting_text'] } } },
  { type: 'function', function: { name: 'send_confirmation_buttons', description: 'Botones Sí/No.', parameters: { type: 'object', properties: { message: { type: 'string' }, buttons: { type: 'array', items: { type: 'string' } } }, required: ['message', 'buttons'] } } },
  { type: 'function', function: { name: 'consult_clinic_info', description: 'Busca info médica, tratamientos y precios.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'save_patient_onboarding', description: 'Guarda nombre.', parameters: { type: 'object', properties: { full_name: { type: 'string' }, age: { type: 'integer' }, allergies_or_meds: { type: 'string' } }, required: ['full_name'] } } },
  { type: 'function', function: { name: 'check_calendar_availability', description: 'Revisa horas.', parameters: { type: 'object', properties: { date_str: { type: 'string' } }, required: ['date_str'] } } },
  { type: 'function', function: { name: 'book_calendar_appointment', description: 'Agenda cita.', parameters: { type: 'object', properties: { start_time: { type: 'string' }, end_time: { type: 'string' }, reason: { type: 'string' }, is_urgent: { type: 'boolean' } }, required: ['start_time', 'end_time', 'reason', 'is_urgent'] } } },
  { type: 'function', function: { name: 'get_my_appointments', description: 'Lista citas futuras.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'cancel_my_appointment', description: 'Cancela cita.', parameters: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] } } },
  { type: 'function', function: { name: 'escalate_to_doctor', description: 'Llama al humano.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } }
];

export async function runPatientAgent(payload: { from: string; content: string }): Promise<void> {
  const { from, content: text } = payload;
  try {
    let { data: patient } = await supabase.from('patients').select('*').eq('phone', from).maybeSingle();
    if (!patient) {
      const { data: created } = await supabase.from('patients').insert({ phone: from, chat_mode: 'AI_ACTIVE' }).select('*').single();
      patient = created;
    }

    const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    await supabase.from('chat_messages').insert({ patient_phone: from, role: 'user', content: text });

    const historyRes = await supabase.from('chat_messages').select('role, content').eq('patient_phone', from).order('created_at', { ascending: false }).limit(10);
    const history = (historyRes.data || []).reverse().map(msg => ({ role: msg.role as 'user' | 'assistant', content: msg.content }));
    
    const fechaActual = new Date().toLocaleString('es-MX', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' });

    const systemPrompt = `Eres "${settings?.bot_name || 'Asistente'}" de "${settings?.clinic_specialty || 'la clínica'}". 
FECHA ACTUAL: ${fechaActual}. BAJO NINGUNA CIRCUNSTANCIA DIGAS QUE ES 2023. USA ESTA FECHA EXACTA.
Paciente actual: ${patient?.full_name || 'Pendiente'}.

REGLAS ESTRICTAS:
1. Si el Paciente es "Pendiente", preséntate y pregunta su nombre.
2. Cuando diga su nombre, usa 'save_patient_onboarding' y muestra opciones con 'show_interactive_menu'.
3. SI EL PACIENTE TOCA "Tratamientos/Precios" EN EL MENÚ: NO busques nada en la base de conocimientos aún. Pregúntale amablemente "¿Qué tratamiento te interesa?" o "¿Sobre qué necesitas información?".
4. Cuando el paciente pregunte algo específico (ej. "Cuánto cuesta una resina"), usa 'consult_clinic_info' enviando las palabras clave ("precio resina").`;

    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, ...history];
    if (history.length === 0 || history[history.length - 1].content !== text) messages.push({ role: 'user', content: text });

    let finalReply = '';
    let hasSentUI = false;

    for (let step = 0; step < 5; step++) {
      const completion = await openai.chat.completions.create({ model: PATIENT_MODEL, temperature: 0.2, messages, tools: PATIENT_TOOLS, tool_choice: 'auto' });
      const assistantMsg = completion.choices[0]?.message;
      if (!assistantMsg) break;
      messages.push(assistantMsg);

      if (!assistantMsg.tool_calls?.length) {
        finalReply = assistantMsg.content || '';
        break;
      }

      for (const toolCall of assistantMsg.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        let output = '';

        try {
          if (name === 'show_interactive_menu') {
            await sendWhatsAppInteractiveList({
              to: from, bodyText: args.greeting_text, buttonText: 'Opciones',
              sections: [
                { title: 'Consultas', rows: [{ id: 'agendar', title: 'Agendar cita' }, { id: 'urgencia', title: 'Cita urgente' }, { id: 'cancelar', title: 'Cancelar/Reagendar' }] },
                { title: 'Servicios', rows: [{ id: 'precios', title: 'Tratamientos/Precios' }, { id: 'faqs', title: 'Info y Políticas' }] },
                { title: 'Atención Médica', rows: [{ id: 'doctor', title: 'Hablar con el doctor' }] }
              ]
            });
            hasSentUI = true; output = 'Menú enviado.';
          } else if (name === 'send_confirmation_buttons') {
            await sendWhatsAppInteractiveButtons({ to: from, bodyText: args.message, buttons: args.buttons });
            hasSentUI = true; output = 'Botones enviados.';
          } else if (name === 'consult_clinic_info') {
            // Bajamos el umbral (threshold) de 0.45 a 0.15 para asegurar que sí encuentre la respuesta
            let matches;
            try { matches = await searchKnowledge(args.query, 4, 0.15); } 
            catch (e) { matches = await searchKnowledge(args.query); }
            output = JSON.stringify((matches && matches.length) ? matches : { error: 'No encontré esa info, ofrécele hablar con el doctor.' });
          } else if (name === 'save_patient_onboarding') {
            await supabase.from('patients').update({ full_name: args.full_name, age: args.age, allergies_or_meds: args.allergies_or_meds }).eq('phone', from);
            output = 'Datos guardados.';
          } else if (name === 'check_calendar_availability') {
            output = JSON.stringify(await getAvailableSlots(args.date_str));
          } else if (name === 'book_calendar_appointment') {
            output = JSON.stringify(await createCalendarAppointment({ patientName: patient?.full_name || 'Paciente', patientPhone: from, startTime: args.start_time, endTime: args.end_time, reason: args.reason, isUrgent: args.is_urgent }));
          } else if (name === 'get_my_appointments') {
            output = JSON.stringify(await getPatientAppointments(from));
          } else if (name === 'cancel_my_appointment') {
            await cancelCalendarEvent(args.event_id); output = 'Cita cancelada.';
          } else if (name === 'escalate_to_doctor') {
            await supabase.from('patients').update({ chat_mode: 'WAITING_HUMAN' }).eq('phone', from);
            if (process.env.ADMIN_PHONE_NUMBER) {
              const wamid = await sendWhatsAppText(String(process.env.ADMIN_PHONE_NUMBER), `🩺 *Consulta de ${patient?.full_name || from}:*\n"${args.summary}"\n\n_Desliza este mensaje y selecciona "Responder" para contestarle._`);
              await supabase.from('escalation_mappings').upsert({ wa_message_id: wamid, patient_phone: from });
            }
            output = 'El doctor fue notificado, dile al paciente que espere.';
          }
        } catch (e) { output = JSON.stringify({ error: String(e) }); }
        
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
      }
    }

    if (!hasSentUI && finalReply) {
      await sendWhatsAppText(from, finalReply);
      await supabase.from('chat_messages').insert({ patient_phone: from, role: 'assistant', content: finalReply });
    }
  } catch (error) { console.error('[Patient Handler Error]:', error); }
}