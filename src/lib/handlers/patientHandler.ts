import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText, sendWhatsAppInteractiveList, sendWhatsAppInteractiveButtons } from '@/lib/whatsapp';
import { searchKnowledge } from '@/lib/knowledge';
import { getAvailableSlots, createCalendarAppointment, getPatientAppointments, cancelCalendarEvent } from '@/lib/calendar';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PATIENT_MODEL = 'gpt-4o-mini';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';

export const dynamic = 'force-dynamic';

const PATIENT_TOOLS: ChatCompletionTool[] = [
  { 
    type: 'function', 
    function: { 
      name: 'show_menu', 
      description: 'Despliega listas de opciones. Tipos válidos: "principal", "tratamientos", "faqs".', 
      parameters: { type: 'object', properties: { menu_type: { type: 'string', enum: ['principal', 'tratamientos', 'faqs'] }, message: { type: 'string' } }, required: ['menu_type', 'message'] } 
    } 
  },
  { type: 'function', function: { name: 'send_confirmation_buttons', description: 'Botones Sí/No.', parameters: { type: 'object', properties: { message: { type: 'string' }, buttons: { type: 'array', items: { type: 'string' } } }, required: ['message', 'buttons'] } } },
  { type: 'function', function: { name: 'consult_clinic_info', description: 'Busca info médica, tratamientos y precios específicos.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'save_patient_onboarding', description: 'Guarda datos.', parameters: { type: 'object', properties: { full_name: { type: 'string' }, age: { type: 'integer' }, allergies_or_meds: { type: 'string' } }, required: ['full_name'] } } },
  { type: 'function', function: { name: 'check_calendar_availability', description: 'Revisa horas.', parameters: { type: 'object', properties: { date_str: { type: 'string' } }, required: ['date_str'] } } },
  { type: 'function', function: { name: 'book_calendar_appointment', description: 'Agenda cita.', parameters: { type: 'object', properties: { start_time: { type: 'string' }, end_time: { type: 'string' }, reason: { type: 'string' }, is_urgent: { type: 'boolean' } }, required: ['start_time', 'end_time', 'reason', 'is_urgent'] } } },
  { type: 'function', function: { name: 'get_my_appointments', description: 'Lista citas.', parameters: { type: 'object', properties: {}, required: [] } } },
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
    
    // Obtenemos la fecha forzada en el huso horario actual para evitar alucinaciones
    const fechaActual = new Date().toLocaleString('es-MX', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' });

    const systemPrompt = `Eres "${settings?.bot_name || 'Asistente'}" de "${settings?.clinic_specialty || 'la clínica'}". 
FECHA ACTUAL GARANTIZADA: ${fechaActual}. PROHIBIDO mencionar fechas de 2023. El sistema actual ya te ha proveído el tiempo exacto.
Paciente actual: ${patient?.full_name || 'Pendiente'}.

REGLAS DE SUB-MENÚS (CASCADA):
1. ONBOARDING: Si el Paciente es "Pendiente", preséntate y pregunta su nombre de inmediato.
2. MENÚ PRINCIPAL: Cuando diga su nombre o pida opciones, usa 'save_patient_onboarding' y luego ejecuta 'show_menu' con menu_type='principal'.
3. ACCIÓN "Tratamientos/Precios": Si el usuario toca esta opción, NO uses consult_clinic_info; DEBES ejecutar 'show_menu' con menu_type='tratamientos'.
4. ACCIÓN "Info y Políticas": Si toca esta opción, NO uses consult_clinic_info; DEBES ejecutar 'show_menu' con menu_type='faqs'.
5. BÚSQUEDA VECTORIAL: Solo cuando el paciente seleccione un tratamiento específico de la sub-lista (ej. "Limpieza Dental", "Resinas") o una FAQ ("Horarios"), usarás 'consult_clinic_info' para buscar esa información exacta y decírsela.`;

    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }, ...history];
    if (history.length === 0 || history[history.length - 1].content !== text) messages.push({ role: 'user', content: text });

    let finalReply = '';
    let hasSentUI = false;

    for (let step = 0; step < 5; step++) {
      const completion = await openai.chat.completions.create({ model: PATIENT_MODEL, temperature: 0.1, messages, tools: PATIENT_TOOLS, tool_choice: 'auto' });
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
          if (name === 'show_menu') {
            let sections: any[] = [];
            
            if (args.menu_type === 'principal') {
              sections = [
                { title: 'Consultas', rows: [{ id: 'agendar', title: 'Agendar cita' }, { id: 'urgencia', title: 'Cita urgente' }, { id: 'cancelar', title: 'Cancelar/Reagendar' }] },
                { title: 'Servicios de la Clínica', rows: [{ id: 'menu_tratamientos', title: 'Tratamientos/Precios' }, { id: 'menu_faqs', title: 'Info y Políticas' }] },
                { title: 'Atención Médica', rows: [{ id: 'doctor', title: 'Hablar con el doctor' }] }
              ];
            } else if (args.menu_type === 'tratamientos') {
              sections = [
                { title: 'Comunes', rows: [{ id: 't_limpieza', title: 'Limpieza Dental' }, { id: 't_resina', title: 'Precio de Resinas' }, { id: 't_extraccion', title: 'Extracciones' }] },
                { title: 'Especiales', rows: [{ id: 't_blanqueamiento', title: 'Blanqueamiento' }, { id: 't_ortodoncia', title: 'Ortodoncia/Brackets' }, { id: 't_radiografia', title: 'Radiografías' }] }
              ];
            } else if (args.menu_type === 'faqs') {
              sections = [
                { title: 'General', rows: [{ id: 'faq_horario', title: 'Horario de la clínica' }, { id: 'faq_ubicacion', title: '¿Dónde están ubicados?' }, { id: 'faq_pagos', title: 'Métodos de pago' }] },
                { title: 'Más info', rows: [{ id: 'faq_cancelaciones', title: 'Política de cancelación' }] }
              ];
            }

            await sendWhatsAppInteractiveList({ to: from, bodyText: args.message || 'Selecciona una opción:', buttonText: 'Ver opciones', sections });
            hasSentUI = true; output = `Menú ${args.menu_type} enviado.`;
            
          } else if (name === 'send_confirmation_buttons') {
            await sendWhatsAppInteractiveButtons({ to: from, bodyText: args.message, buttons: args.buttons });
            hasSentUI = true; output = 'Botones enviados.';
          } else if (name === 'consult_clinic_info') {
            // Buscamos directamente con similitud baja para traer resultados seguros
            let matches = await searchKnowledge(args.query, 4, 0.15);
            output = JSON.stringify((matches && matches.length) ? matches : { error: 'No encontré esa info, avisa al doctor.' });
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
              const wamid = await sendWhatsAppText(String(process.env.ADMIN_PHONE_NUMBER), `🩺 *Consulta de ${patient?.full_name || from}:*\n"${args.summary}"\n\n_Desliza este mensaje para responderle._`);
              await supabase.from('escalation_mappings').upsert({ wa_message_id: wamid, patient_phone: from });
            }
            output = 'El doctor fue notificado.';
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