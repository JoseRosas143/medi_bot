import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import { sendWhatsAppText } from '@/lib/whatsapp';
import { searchKnowledge } from '@/lib/knowledge';
import {
  createCalendarAppointment,
  getAvailableSlots,
} from '@/lib/calendar';
import type {
  BotSettings,
  ChatMessage,
  IncomingMessage,
  MatchedKnowledge,
  Patient,
} from '@/types/database';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PATIENT_MODEL = 'gpt-4o-mini';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';

const PATIENT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'consult_clinic_info',
      description:
        'Busca información oficial de la clínica en la base de conocimientos (precios, tratamientos, horarios, ubicación, preparación previa y preguntas frecuentes). Úsala SIEMPRE antes de responder dudas sobre la clínica.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Consulta semántica clara con lo que pregunta el paciente (ej. "precio limpieza dental", "horario sábado", "preparación extracción").',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_patient_onboarding',
      description:
        'Guarda los datos clínicos básicos del paciente cuando ya proporcionó su nombre completo, edad y alergias o medicamentos actuales (o indicó que no tiene).',
      parameters: {
        type: 'object',
        properties: {
          full_name: {
            type: 'string',
            description: 'Nombre completo del paciente.',
          },
          age: {
            type: 'integer',
            description: 'Edad del paciente en años.',
          },
          allergies_or_meds: {
            type: 'string',
            description:
              'Alergias a medicamentos/anestesia o tratamientos actuales (ej. "Ninguna", "Alérgico a penicilina").',
          },
        },
        required: ['full_name', 'age', 'allergies_or_meds'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_calendar_availability',
      description:
        'Consulta los horarios disponibles en Google Calendar para una fecha específica.',
      parameters: {
        type: 'object',
        properties: {
          date_str: {
            type: 'string',
            description: 'Fecha a consultar en formato estricto YYYY-MM-DD.',
          },
        },
        required: ['date_str'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_calendar_appointment',
      description:
        'Agenda una cita confirmada en Google Calendar. Requiere que el paciente ya tenga su onboarding completado.',
      parameters: {
        type: 'object',
        properties: {
          start_time: {
            type: 'string',
            description:
              'Fecha y hora de inicio exactas obtenidas de check_calendar_availability en formato ISO 8601.',
          },
          end_time: {
            type: 'string',
            description:
              'Fecha y hora de fin exactas obtenidas de check_calendar_availability en formato ISO 8601.',
          },
          reason: {
            type: 'string',
            description:
              'Motivo principal de la consulta (ej. "Limpieza dental", "Dolor en molar").',
          },
          clinical_summary: {
            type: 'string',
            description:
              'Resumen clínico breve (máximo 3 líneas) con edad, motivo, síntomas y alergias/medicamentos del paciente.',
          },
          is_urgent: {
            type: 'boolean',
            description:
              'True si el paciente reporta dolor agudo, sangrado activo, traumatismo o inflamación severa.',
          },
        },
        required: [
          'start_time',
          'end_time',
          'reason',
          'clinical_summary',
          'is_urgent',
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify_admin_urgency',
      description:
        'Envía una alerta inmediata por WhatsApp al doctor/administrador cuando un paciente reporta síntomas de urgencia clínica (dolor agudo, sangrado activo, traumatismo o inflamación severa).',
      parameters: {
        type: 'object',
        properties: {
          patient_name: {
            type: 'string',
            description: 'Nombre del paciente.',
          },
          symptoms_summary: {
            type: 'string',
            description: 'Descripción concisa de los síntomas urgentes reportados.',
          },
        },
        required: ['patient_name', 'symptoms_summary'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_doctor',
      description:
        'Transfiere la conversación al humano/doctor cuando el paciente lo solicita explícitamente o tiene una duda médica compleja.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'Resumen breve de la duda por la cual el paciente quiere hablar con el doctor.',
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  },
];

async function getOrCreatePatient(phone: string): Promise<Patient> {
  const { data: existing } = await supabase
    .from('patients')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  if (existing) {
    return existing as Patient;
  }

  const { data: created, error } = await supabase
    .from('patients')
    .insert({
      phone,
      onboarding_completed: false,
      chat_mode: 'AI_ACTIVE',
    })
    .select('*')
    .single();

  if (error || !created) {
    throw new Error(`Error creando registro de paciente: ${error?.message}`);
  }

  return created as Patient;
}

async function getBotSettings(): Promise<BotSettings> {
  const { data } = await supabase
    .from('bot_settings')
    .select('*')
    .eq('id', 1)
    .single();

  return (
    (data as BotSettings | null) ?? {
      id: 1,
      bot_name: 'Asistente Clínico',
      clinic_specialty: null,
      updated_at: new Date().toISOString(),
    }
  );
}

async function getRecentChatHistory(
  patientPhone: string,
  limit = 10
): Promise<ChatCompletionMessageParam[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('patient_phone', patientPhone)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) {
    console.error('[PatientHandler] Error recuperando historial:', error);
    return [];
  }

  const chronological = (
    data as Pick<ChatMessage, 'role' | 'content'>[]
  ).reverse();

  return chronological.map((msg) => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content,
  }));
}

async function saveChatMessage(
  patientPhone: string,
  role: 'user' | 'assistant' | 'doctor',
  content: string
): Promise<void> {
  const { error } = await supabase.from('chat_messages').insert({
    patient_phone: patientPhone,
    role,
    content,
  });

  if (error) {
    console.error(`[PatientHandler] Error guardando mensaje (${role}):`, error);
  }
}

async function executePatientTool(
  name: string,
  rawArgs: string,
  patient: Patient
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({
      success: false,
      error: 'Argumentos JSON inválidos.',
    });
  }

  switch (name) {
    case 'consult_clinic_info': {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return JSON.stringify({
          found: false,
          error: 'La consulta está vacía.',
        });
      }

      const matches = await searchKnowledge(query, 4, 0.45);
      if (matches.length === 0) {
        return JSON.stringify({
          found: false,
          message:
            'No se encontró información sobre este tema en la base de conocimientos de la clínica.',
        });
      }

      return JSON.stringify({
        found: true,
        results: matches.map((m: MatchedKnowledge) => ({
          category: m.category,
          content: m.content,
          relevance: Number(m.similarity.toFixed(3)),
        })),
      });
    }

    case 'save_patient_onboarding': {
      const fullName = String(args.full_name ?? '').trim();
      const age = Number(args.age);
      const allergiesOrMeds = String(
        args.allergies_or_meds ?? 'Ninguna'
      ).trim();

      if (!fullName || !Number.isInteger(age) || age <= 0) {
        return JSON.stringify({
          success: false,
          error: 'Se requiere nombre completo y edad válida en años.',
        });
      }

      const { error } = await supabase
        .from('patients')
        .update({
          full_name: fullName,
          age,
          allergies_or_meds: allergiesOrMeds,
          onboarding_completed: true,
          updated_at: new Date().toISOString(),
        })
        .eq('phone', patient.phone);

      if (error) {
        return JSON.stringify({ success: false, error: error.message });
      }

      patient.full_name = fullName;
      patient.age = age;
      patient.allergies_or_meds = allergiesOrMeds;
      patient.onboarding_completed = true;

      return JSON.stringify({
        success: true,
        message: 'Ficha clínica básica del paciente guardada correctamente.',
      });
    }

    case 'check_calendar_availability': {
      const dateStr = String(args.date_str ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return JSON.stringify({
          success: false,
          error: 'Formato de fecha inválido. Usa YYYY-MM-DD.',
        });
      }

      const slots = await getAvailableSlots(dateStr, 45);
      if (slots.length === 0) {
        return JSON.stringify({
          success: true,
          available: false,
          message: `No hay horarios disponibles para el ${dateStr}.`,
        });
      }

      return JSON.stringify({
        success: true,
        available: true,
        date: dateStr,
        slots,
      });
    }

    case 'book_calendar_appointment': {
      if (!patient.onboarding_completed || !patient.full_name) {
        return JSON.stringify({
          success: false,
          error:
            'ONBOARDING_REQUIRED: Antes de agendar, debes recopilar nombre completo, edad y alergias/medicamentos y guardarlos con save_patient_onboarding.',
        });
      }

      const startTime = String(args.start_time ?? '').trim();
      const endTime = String(args.end_time ?? '').trim();
      const reason = String(args.reason ?? 'Consulta general').trim();
      const clinicalSummary = String(args.clinical_summary ?? '').trim();
      const isUrgent = Boolean(args.is_urgent);

      try {
        const created = await createCalendarAppointment({
          patientName: patient.full_name,
          patientPhone: patient.phone,
          startTime,
          endTime,
          reason,
          clinicalSummary,
          isUrgent,
        });

        if (isUrgent && process.env.ADMIN_PHONE_NUMBER) {
          await sendWhatsAppText(
            process.env.ADMIN_PHONE_NUMBER,
            `🚨 *CITA DE URGENCIA AGENDADA*\nPaciente: ${patient.full_name} (${patient.phone})\nHorario: ${created.formattedDateTime}\nMotivo: ${reason}\nResumen: ${clinicalSummary}`
          );
        }

        return JSON.stringify({
          success: true,
          event_id: created.eventId,
          formatted_date_time: created.formattedDateTime,
          is_urgent: isUrgent,
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'SLOT_OCCUPIED') {
          return JSON.stringify({
            success: false,
            error:
              'Ese horario acaba de ser ocupado por otro paciente. Consulta de nuevo check_calendar_availability y ofrece otra opción.',
          });
        }
        throw err;
      }
    }

    case 'notify_admin_urgency': {
      const adminPhone = process.env.ADMIN_PHONE_NUMBER;
      const patientName = String(
        args.patient_name ?? patient.full_name ?? 'Paciente'
      ).trim();
      const symptomsSummary = String(args.symptoms_summary ?? '').trim();

      if (adminPhone) {
        await sendWhatsAppText(
          adminPhone,
          `🚨 *ALERTA DE TRIAJE URGENTE*\nPaciente: ${patientName} (${patient.phone})\nSíntomas reportados: ${symptomsSummary}\n\n_El asistente está gestionando su atención prioritaria._`
        );
      }

      return JSON.stringify({
        success: true,
        notified: Boolean(adminPhone),
      });
    }

    case 'escalate_to_doctor': {
      const summary = String(
        args.summary ?? 'Solicita atención humana'
      ).trim();
      const adminPhone = process.env.ADMIN_PHONE_NUMBER;

      if (!adminPhone) {
        return JSON.stringify({
          success: false,
          error: 'No hay número administrador configurado.',
        });
      }

      await supabase
        .from('patients')
        .update({ chat_mode: 'WAITING_HUMAN' })
        .eq('phone', patient.phone);

      const notification = `🩺 *Consulta de ${patient.full_name || 'Paciente'}* (${patient.phone}):\n"${summary}"\n\n_Desliza este mensaje para responderle directamente o escribe "cerrar" para devolverlo a la IA._`;
      const wamid = await sendWhatsAppText(adminPhone, notification);

      await supabase.from('escalation_mappings').upsert({
        wa_message_id: wamid,
        patient_phone: patient.phone,
      });

      return JSON.stringify({
        success: true,
        message:
          'Chat transferido. Despídete indicando al paciente que el doctor le responderá a la brevedad por este mismo medio.',
      });
    }

    default:
      return JSON.stringify({
        success: false,
        error: `Herramienta desconocida: ${name}`,
      });
  }
}

/**
 * Procesa los mensajes entrantes de pacientes: RAG, Onboarding, Triaje, Citas y Escalación.
 */
export async function runPatientAgent(
  payload: IncomingMessage
): Promise<void> {
  const { from, content: text } = payload;

  try {
    const [patient, settings] = await Promise.all([
      getOrCreatePatient(from),
      getBotSettings(),
    ]);

    await saveChatMessage(from, 'user', text);

    if (patient.chat_mode === 'WAITING_HUMAN') {
      await sendWhatsAppText(
        from,
        'Tu mensaje ya fue canalizado con el especialista. En breve te responderá por este mismo medio.'
      );
      return;
    }

    const history = await getRecentChatHistory(from, 10);

    const todayReadable = new Intl.DateTimeFormat('es-MX', {
      timeZone: TIMEZONE,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());

    const systemPrompt = `Eres "${settings.bot_name}", asistente virtual de atención a pacientes de la clínica${
      settings.clinic_specialty ? ` especializada en ${settings.clinic_specialty}` : ''
    }.
Fecha y hora actual de la clínica: ${todayReadable} (Zona horaria: ${TIMEZONE}).

Estado actual del expediente del paciente:
- Teléfono: ${patient.phone}
- Onboarding completado: ${patient.onboarding_completed ? 'SÍ' : 'NO'}
- Nombre: ${patient.full_name ?? 'Pendiente'}
- Edad: ${patient.age ?? 'Pendiente'}
- Alergias/Medicamentos: ${patient.allergies_or_meds ?? 'Pendiente'}

Reglas estrictas de comportamiento:
1. **Onboarding conversacional (Presentación y Saludo):** Si el paciente no tiene un nombre registrado ("Pendiente") y es su primer mensaje, preséntate de forma cálida indicando tu nombre y el de la clínica, y pregúntale amablemente su nombre para poder atenderle mejor.
2. **Registro de Onboarding:** Cuando el paciente indique su nombre (y durante la conversación obtengas también su edad, motivo de consulta y alergias/medicamentos), ejecuta la herramienta \`save_patient_onboarding\` para guardar sus datos en el expediente.
3. **Base de Conocimientos:** SIEMPRE usa \`consult_clinic_info\` cuando pregunten por precios, servicios, tratamientos, horarios de atención, ubicación, métodos de pago o preparación previa. Nunca inventes información. Si no está en la base, dilo amablemente y ofrece comunicarlo con el especialista.
4. **Triaje de Urgencias:** Si menciona dolor agudo/insoportable, sangrado activo, traumatismo o inflamación severa, activa \`notify_admin_urgency\` de inmediato y marca \`is_urgent: true\` al agendar su cita.
5. **Agendamiento:** Usa \`check_calendar_availability\` para ofrecer horarios reales y \`book_calendar_appointment\` para confirmar la cita redactando un resumen clínico claro de máximo 3 líneas.
6. **Derivación al Doctor:** Si el paciente pide hablar con el doctor/persona o hace una pregunta médica compleja que requiere criterio clínico, ejecuta inmediatamente \`escalate_to_doctor\`. No emitas diagnósticos médicos ni recetes medicamentos.
7. Mantén respuestas cálidas, empáticas, breves y fáciles de leer en WhatsApp.`;

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];

    const lastHistoryMsg = history[history.length - 1];
    if (
      !lastHistoryMsg ||
      lastHistoryMsg.role !== 'user' ||
      lastHistoryMsg.content !== text
    ) {
      messages.push({ role: 'user', content: text });
    }

    let finalReply = '';

    for (let step = 0; step < 6; step++) {
      const completion = await openai.chat.completions.create({
        model: PATIENT_MODEL,
        temperature: 0.3,
        messages,
        tools: PATIENT_TOOLS,
        tool_choice: 'auto',
      });

      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error('Respuesta vacía del modelo en patientHandler.');
      }

      messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        finalReply =
          assistantMessage.content?.trim() ||
          'Con gusto te ayudo. ¿Podrías darme un poco más de detalle sobre lo que necesitas?';
        break;
      }

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') continue;

        const toolOutput = await executePatientTool(
          toolCall.function.name,
          toolCall.function.arguments,
          patient
        );

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolOutput,
        });
      }
    }

    if (!finalReply) {
      finalReply =
        'No cuento con ese dato exacto en este momento. ¿Te gustaría que canalice tu consulta directamente con el doctor?';
    }

    await saveChatMessage(from, 'assistant', finalReply);
    await sendWhatsAppText(from, finalReply);
  } catch (error) {
    console.error('[PatientHandler] Error procesando mensaje del paciente:', error);
    await sendWhatsAppText(
      from,
      'Disculpa, tuve un breve inconveniente técnico al procesar tu mensaje. ¿Podrías intentarlo nuevamente en un momento?'
    );
  }
}