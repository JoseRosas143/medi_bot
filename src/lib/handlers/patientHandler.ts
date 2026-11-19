import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText, sendWhatsAppInteractiveList, sendWhatsAppInteractiveButtons } from '@/lib/whatsapp';
import { searchKnowledge } from '@/lib/knowledge';
import { getAvailableSlots, createCalendarAppointment, getPatientAppointments, cancelCalendarEvent } from '@/lib/calendar';
import type { BotSettings, ChatMessage, IncomingMessage, Patient } from '@/types/database';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PATIENT_MODEL = 'gpt-4o-mini';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';

const PATIENT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'show_interactive_menu',
      description: 'Envía el menú principal interactivo de WhatsApp al paciente. Úsalo inmediatamente después de que el paciente te diga su nombre.',
      parameters: {
        type: 'object',
        properties: {
          greeting_text: { type: 'string', description: 'Texto que acompañará al menú. Ej: "Hola José, estas son las opciones:"' }
        },
        required: ['greeting_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_confirmation_buttons',
      description: 'Envía una pregunta con botones de respuesta rápida (ej. Sí / No).',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          buttons: { type: 'array', items: { type: 'string' } }
        },
        required: ['message', 'buttons'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consult_clinic_info',
      description: 'Busca FAQS, tratamientos, precios e información oficial en la base de conocimientos.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_patient_onboarding',
      description: 'Guarda o actualiza los datos del paciente (nombre, edad, alergias).',
      parameters: {
        type: 'object',
        properties: {
          full_name: { type: 'string' },
          age: { type: 'integer' },
          allergies_or_meds: { type: 'string' },
        },
        required: ['full_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_calendar_availability',
      description: 'Consulta los horarios disponibles en Google Calendar para una fecha YYYY-MM-DD.',
      parameters: { type: 'object', properties: { date_str: { type: 'string' } }, required: ['date_str'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_calendar_appointment',
      description: 'Agenda una cita confirmada en Google Calendar.',
      parameters: {
        type: 'object',
        properties: {
          start_time: { type: 'string', description: 'Formato ISO 8601' },
          end_time: { type: 'string', description: 'Formato ISO 8601' },
          reason: { type: 'string' },
          is_urgent: { type: 'boolean' },
        },
        required: ['start_time', 'end_time', 'reason', 'is_urgent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_doctor',
      description: 'Transfiere la conversación al humano/doctor.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_appointments',
      description: 'Busca las citas futuras guardadas de este paciente para poder cancelarlas o reagendarlas.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_my_appointment',
      description: 'Cancela una cita del paciente usando el eventId obtenido previamente.',
      parameters: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'] },
    },
  },
];

async function getOrCreatePatient(phone: string): Promise<Patient> {
  let { data: patient } = await supabase.from('patients').select('*').eq('phone', phone).maybeSingle();
  if (!patient) {
    const { data: created } = await supabase.from('patients').insert({ phone, chat_mode: 'AI_ACTIVE' }).select('*').single();
    patient = created;
  }
  return patient as Patient;
}

export async function runPatientAgent(payload: IncomingMessage): Promise<void> {
  const { from, content: text } = payload;

  try {
    const [patient, { data: settings }] = await Promise.all([
      getOrCreatePatient(from),
      supabase.from('bot_settings').select('*').eq('id', 1).single()
    ]);

    await supabase.from('chat_messages').insert({ patient_phone: from, role: 'user', content: text });

    const historyResponse = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('patient_phone', from)
      .order('created_at', { ascending: false })
      .limit(10);
    const history = (historyResponse.data || []).reverse().map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    })) as ChatCompletionMessageParam[];

    const botName = settings?.bot_name || 'Asistente Clínico';
    const clinicName = settings?.clinic_specialty || 'la clínica';
    
    const systemPrompt = `Eres "${botName}", asistente virtual de "${clinicName}". 
Fecha actual: ${new Intl.DateTimeFormat('es-MX', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' }).format(new Date())}.
Estado del paciente: Nombre: ${patient.full_name || 'Pendiente'}.

REGLAS DE INTERACCIÓN (SÍGUELAS ESTRICTAMENTE):
1. **Onboarding:** Si el Nombre es "Pendiente" y el usuario dice Hola, salúdalo preguntando cómo se llama.
2. **Despliegue de Menú:** Cuando el usuario diga su nombre, usa \`save_patient_onboarding\` e INMEDIATAMENTE usa \`show_interactive_menu\`.
3. **Botones de Confirmación:** Usa \`send_confirmation_buttons\` para confirmar citas o cancelaciones.
4. **Agendar:** Pide edad y motivo, revisa horarios, y usa \`book_calendar_appointment\`. Si es urgencia, marca is_urgent=true.
5. **Cancelar/Reagendar:** Usa \`get_my_appointments\` para buscar sus citas futuras y \`cancel_my_appointment\` para borrarla.
6. **Hablar con el doctor:** Ejecuta \`escalate_to_doctor\`.`;

    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, ...history];
    if (history.length === 0 || history[history.length - 1].content !== text) {
      messages.push({ role: 'user', content: text });
    }

    let finalReply = '';
    let hasSentInteractiveUI = false;

    for (let step = 0; step < 5; step++) {
      const completion = await openai.chat.completions.create({
        model: PATIENT_MODEL, temperature: 0.3, messages, tools: PATIENT_TOOLS, tool_choice: 'auto'
      });

      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) break;
      messages.push(assistantMessage);

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        finalReply = assistantMessage.content || '';
        break;
      }

      for (const toolCall of assistantMessage.tool_calls) {
        if (toolCall.type !== 'function') continue; // <-- Esto corrige el error de TypeScript
        
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        let output = '';

        if (name === 'show_interactive_menu') {
          await sendWhatsAppInteractiveList({
            to: from,
            bodyText: args.greeting_text,
            buttonText: 'Ver opciones',
            sections: [
              { title: 'Consultas', rows: [{ id: 'agendar', title: 'Agendar cita' }, { id: 'urgencia', title: 'Cita de urgencia' }, { id: 'cancelar', title: 'Cancelar mi cita' }] },
              { title: 'Información', rows: [{ id: 'precios', title: 'Tratamientos/precios' }, { id: 'tratamiento', title: 'Mi tratamiento' }, { id: 'faqs', title: 'FAQS' }] },
              { title: 'Atención Personal', rows: [ { id: 'doctor', title: 'Hablar con el doctor' } ] }
            ]
          });
          hasSentInteractiveUI = true;
          output = JSON.stringify({ success: true, message: 'Menú enviado.' });
        }
        else if (name === 'send_confirmation_buttons') {
          await sendWhatsAppInteractiveButtons({ to: from, bodyText: args.message, buttons: args.buttons });
          hasSentInteractiveUI = true;
          output = JSON.stringify({ success: true, message: 'Botones enviados.' });
        }
        else if (name === 'consult_clinic_info') {
          const matches = await searchKnowledge(args.query, 4, 0.45);
          output = JSON.stringify(matches.length ? matches : { error: 'Sin información.' });
        }
        else if (name === 'save_patient_onboarding') {
          await supabase.from('patients').update({
            full_name: args.full_name || patient.full_name, age: args.age || patient.age, allergies_or_meds: args.allergies_or_meds || patient.allergies_or_meds
          }).eq('phone', from);
          patient.full_name = args.full_name || patient.full_name; 
          output = JSON.stringify({ success: true });
        }
        else if (name === 'check_calendar_availability') {
          output = JSON.stringify(await getAvailableSlots(args.date_str, 45));
        }
        else if (name === 'book_calendar_appointment') {
          try {
            const result = await createCalendarAppointment({ patientName: patient.full_name || 'Paciente', patientPhone: from, startTime: args.start_time, endTime: args.end_time, reason: args.reason, clinicalSummary: `Edad: ${patient.age || 'N/A'}. Alergias: ${patient.allergies_or_meds || 'N/A'}`, isUrgent: args.is_urgent });
            output = JSON.stringify(result);
          } catch (err) { output = JSON.stringify({ error: String(err) }); }
        }
        else if (name === 'get_my_appointments') {
          output = JSON.stringify(await getPatientAppointments(from));
        }
        else if (name === 'cancel_my_appointment') {
          try {
            await cancelCalendarEvent(args.event_id);
            output = JSON.stringify({ success: true, message: 'Cita cancelada exitosamente.' });
          } catch (err) { output = JSON.stringify({ error: String(err) }); }
        }
        else if (name === 'escalate_to_doctor') {
          await supabase.from('patients').update({ chat_mode: 'WAITING_HUMAN' }).eq('phone', from);
          if (process.env.ADMIN_PHONE_NUMBER) {
            const wamid = await sendWhatsAppText(process.env.ADMIN_PHONE_NUMBER, `🩺 *Consulta de ${patient.full_name || from}:*\n"${args.summary}"\n\n_Desliza para responder._`);
            await supabase.from('escalation_mappings').upsert({ wa_message_id: wamid, patient_phone: from });
          }
          output = JSON.stringify({ success: true });
        }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: output });
      }
    }

    if (!hasSentInteractiveUI && finalReply) {
      await sendWhatsAppText(from, finalReply);
      await supabase.from('chat_messages').insert({ patient_phone: from, role: 'assistant', content: finalReply });
    }
  } catch (error) {
    console.error('[Patient Error]:', error);
  }
}