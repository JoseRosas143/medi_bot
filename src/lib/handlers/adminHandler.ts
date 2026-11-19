import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { supabaseAdmin as supabase } from '@/lib/supabase';
import {
  notifyPatientCancellation,
  sendWhatsAppText,
} from '@/lib/whatsapp';
import { updateKnowledge } from '@/lib/knowledge';
import {
  cancelCalendarEvent,
  findAppointments,
  getAppointmentsByDateRange,
} from '@/lib/calendar';
import type { IncomingMessage } from '@/lib/message-handlers';
import type {
  BotSettings,
  ClinicTask,
  KnowledgeCategory,
} from '@/types/database';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ADMIN_MODEL = 'gpt-4o-mini';
const TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';
const TIMEZONE_OFFSET = '-06:00';

const ADMIN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'change_bot_name',
      description:
        'Actualiza el nombre público con el que se presenta el asistente virtual de la clínica.',
      parameters: {
        type: 'object',
        properties: {
          new_name: {
            type: 'string',
            description: 'Nuevo nombre para el bot (ej. "Dra. Sofía", "Asistente Dental").',
          },
        },
        required: ['new_name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_clinic_knowledge',
      description:
        'Guarda o actualiza precios, horarios, servicios, ubicación o preguntas frecuentes en la base de conocimientos de la clínica.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['precios', 'horarios', 'servicios', 'faq', 'ubicacion'],
            description: 'Categoría a la que pertenece la información.',
          },
          information: {
            type: 'string',
            description:
              'Dato claro y completo a guardar (ej. "La limpieza dental con ultrasonido cuesta $900 MXN").',
          },
        },
        required: ['category', 'information'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_clinic_tasks',
      description:
        'Gestiona la lista de pendientes operativos de la clínica: agregar un pendiente, listar los pendientes activos o marcar uno o varios como completados.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'list', 'complete'],
            description: 'Acción a realizar sobre los pendientes.',
          },
          description: {
            type: 'string',
            description: 'Descripción del pendiente (obligatorio cuando action es "add").',
          },
          task_numbers: {
            type: 'array',
            items: { type: 'integer' },
            description:
              'Números de lista o IDs de los pendientes a completar (obligatorio cuando action es "complete").',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_schedule_by_date',
      description:
        'Consulta las citas agendadas en Google Calendar para una fecha específica (hoy, mañana o cualquier fecha YYYY-MM-DD).',
      parameters: {
        type: 'object',
        properties: {
          date_str: {
            type: 'string',
            description: 'Fecha a consultar en formato YYYY-MM-DD.',
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
      name: 'search_appointments_to_cancel',
      description:
        'Busca citas activas en Google Calendar por nombre de paciente y/o fecha para obtener sus eventId exactos antes de cancelar.',
      parameters: {
        type: 'object',
        properties: {
          date_str: {
            type: 'string',
            description: 'Fecha opcional en formato YYYY-MM-DD.',
          },
          patient_name: {
            type: 'string',
            description: 'Nombre parcial o completo del paciente opcional.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_patient_appointments',
      description:
        'Cancela una o varias citas en Google Calendar por sus eventId y notifica automáticamente por WhatsApp a cada paciente afectado.',
      parameters: {
        type: 'object',
        properties: {
          event_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de eventId exactos de Google Calendar a cancelar.',
          },
          reason: {
            type: 'string',
            description:
              'Motivo opcional de la cancelación (ej. "cirugía de urgencia", "imprevisto médico").',
          },
        },
        required: ['event_ids'],
        additionalProperties: false,
      },
    },
  },
];

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

async function executeAdminTool(
  name: string,
  rawArgs: string
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({ success: false, error: 'Argumentos JSON inválidos.' });
  }

  switch (name) {
    case 'change_bot_name': {
      const newName = String(args.new_name ?? '').trim();
      if (!newName) {
        return JSON.stringify({ success: false, error: 'El nombre no puede estar vacío.' });
      }

      const { error } = await supabase.from('bot_settings').upsert({
        id: 1,
        bot_name: newName,
        updated_at: new Date().toISOString(),
      });

      if (error) {
        return JSON.stringify({ success: false, error: error.message });
      }

      return JSON.stringify({
        success: true,
        message: `Nombre actualizado correctamente a "${newName}".`,
      });
    }

    case 'upsert_clinic_knowledge': {
      const category = args.category as KnowledgeCategory;
      const information = String(args.information ?? '').trim();

      if (!category || !information) {
        return JSON.stringify({
          success: false,
          error: 'Se requiere categoría e información válida.',
        });
      }

      const result = await updateKnowledge(category, information);
      return JSON.stringify({
        success: true,
        inserted_id: result.insertedId,
        deactivated_previous_records: result.deactivatedCount,
      });
    }

    case 'manage_clinic_tasks': {
      const action = String(args.action ?? '');

      if (action === 'add') {
        const description = String(args.description ?? '').trim();
        if (!description) {
          return JSON.stringify({ success: false, error: 'Falta la descripción del pendiente.' });
        }

        const { data, error } = await supabase
          .from('clinic_tasks')
          .insert({ description, is_completed: false })
          .select('id, description')
          .single();

        if (error) {
          return JSON.stringify({ success: false, error: error.message });
        }

        return JSON.stringify({ success: true, task: data });
      }

      if (action === 'list') {
        const { data, error } = await supabase
          .from('clinic_tasks')
          .select('id, description, created_at')
          .eq('is_completed', false)
          .order('id', { ascending: true });

        if (error) {
          return JSON.stringify({ success: false, error: error.message });
        }

        const tasks = (data as Pick<ClinicTask, 'id' | 'description' | 'created_at'>[]) ?? [];
        const numberedTasks = tasks.map((task, idx) => ({
          numero: idx + 1,
          id: task.id,
          description: task.description,
        }));

        return JSON.stringify({
          success: true,
          total_active: numberedTasks.length,
          tasks: numberedTasks,
        });
      }

      if (action === 'complete') {
        const numbers = Array.isArray(args.task_numbers)
          ? args.task_numbers.map(Number).filter((n) => Number.isInteger(n) && n > 0)
          : [];

        if (numbers.length === 0) {
          return JSON.stringify({
            success: false,
            error: 'Indica al menos un número de pendiente a completar.',
          });
        }

        const { data: activeData, error: fetchError } = await supabase
          .from('clinic_tasks')
          .select('id, description')
          .eq('is_completed', false)
          .order('id', { ascending: true });

        if (fetchError) {
          return JSON.stringify({ success: false, error: fetchError.message });
        }

        const activeTasks = (activeData as Pick<ClinicTask, 'id' | 'description'>[]) ?? [];
        const idsToComplete = new Set<number>();

        for (const num of numbers) {
          const byPosition = activeTasks[num - 1];
          if (byPosition) {
            idsToComplete.add(byPosition.id);
          } else {
            const byId = activeTasks.find((t) => t.id === num);
            if (byId) idsToComplete.add(byId.id);
          }
        }

        if (idsToComplete.size === 0) {
          return JSON.stringify({
            success: false,
            error: 'No se encontraron pendientes activos con esos números.',
          });
        }

        const targetIds = Array.from(idsToComplete);
        const { error: updateError } = await supabase
          .from('clinic_tasks')
          .update({ is_completed: true })
          .in('id', targetIds);

        if (updateError) {
          return JSON.stringify({ success: false, error: updateError.message });
        }

        return JSON.stringify({
          success: true,
          completed_count: targetIds.length,
          completed_ids: targetIds,
        });
      }

      return JSON.stringify({ success: false, error: `Acción no soportada: ${action}` });
    }

    case 'get_schedule_by_date': {
      const dateStr = String(args.date_str ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return JSON.stringify({
          success: false,
          error: 'Formato de fecha inválido. Usa YYYY-MM-DD.',
        });
      }

      const startIso = `${dateStr}T00:00:00${TIMEZONE_OFFSET}`;
      const endIso = `${dateStr}T23:59:59${TIMEZONE_OFFSET}`;
      const appointments = await getAppointmentsByDateRange(startIso, endIso);

      return JSON.stringify({
        success: true,
        date: dateStr,
        total_appointments: appointments.length,
        appointments,
      });
    }

    case 'search_appointments_to_cancel': {
      const dateStr = args.date_str ? String(args.date_str).trim() : undefined;
      const patientName = args.patient_name ? String(args.patient_name).trim() : undefined;

      const matches = await findAppointments({ dateStr, patientName });
      return JSON.stringify({
        success: true,
        total_found: matches.length,
        appointments: matches,
      });
    }

    case 'cancel_patient_appointments': {
      const eventIds = Array.isArray(args.event_ids)
        ? args.event_ids.map(String).filter(Boolean)
        : [];
      const reason = args.reason ? String(args.reason).trim() : undefined;

      if (eventIds.length === 0) {
        return JSON.stringify({
          success: false,
          error: 'Debes proporcionar al menos un event_id válido.',
        });
      }

      const cancelledSummary: Array<{
        patientName: string;
        appointmentDateText: string;
        notifiedViaWhatsApp: boolean;
      }> = [];

      for (const eventId of eventIds) {
        const cancelled = await cancelCalendarEvent(eventId);
        let notified = false;

        if (cancelled.patientPhone) {
          await notifyPatientCancellation({
            patientPhone: cancelled.patientPhone,
            patientName: cancelled.patientName,
            appointmentDateText: cancelled.appointmentDateText,
            reason,
          });
          notified = true;
        }

        cancelledSummary.push({
          patientName: cancelled.patientName,
          appointmentDateText: cancelled.appointmentDateText,
          notifiedViaWhatsApp: notified,
        });
      }

      return JSON.stringify({
        success: true,
        cancelled_count: cancelledSummary.length,
        details: cancelledSummary,
      });
    }

    default:
      return JSON.stringify({ success: false, error: `Herramienta desconocida: ${name}` });
  }
}

/**
 * Procesa los mensajes entrantes del número Administrador.
 */
export async function runAdminAgent(payload: IncomingMessage): Promise<void> {
  const { from, content: text } = payload;

  try {
    const settings = await getBotSettings();

    const todayReadable = new Intl.DateTimeFormat('es-MX', {
      timeZone: TIMEZONE,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `Eres "${settings.bot_name}", el Gerente Operativo IA de la clínica${
          settings.clinic_specialty ? ` (${settings.clinic_specialty})` : ''
        }.
Fecha y hora actual de la clínica: ${todayReadable} (Zona horaria: ${TIMEZONE}).
Estás hablando directamente con el Administrador / Profesional titular por WhatsApp.

Tus responsabilidades y herramientas:
1. Cambiar tu nombre operativo (\`change_bot_name\`).
2. Actualizar o agregar precios, horarios, servicios, ubicación o políticas a la base de conocimientos (\`upsert_clinic_knowledge\`).
3. Gestionar pendientes operativos (\`manage_clinic_tasks\`): agregar, listar numerados y tachar/completar.
4. Consultar la agenda de cualquier día (\`get_schedule_by_date\`) entregando conteo total y desglose cronológico.
5. Cancelar citas (\`search_appointments_to_cancel\` + \`cancel_patient_appointments\`):
   - Primero busca las citas correspondientes.
   - Si el doctor pide cancelar por nombre (ej. "Cancela la cita de María") y hay más de una coincidencia, lístalas con fecha/hora y pide confirmación antes de borrar.
   - Si pide cancelar en bloque (ej. "Cancela todas las citas de mañana por la tarde por cirugía"), filtra las citas que entren en ese rango horario, cancélalas todas, notifica a cada paciente y entrega un resumen claro confirmando a quiénes se les avisó.

Estilo de respuesta:
- Directo, ejecutivo, eficiente y amable, optimizado para WhatsApp.`,
      },
      {
        role: 'user',
        content: text,
      },
    ];

    for (let step = 0; step < 6; step++) {
      const completion = await openai.chat.completions.create({
        model: ADMIN_MODEL,
        temperature: 0.2,
        messages,
        tools: ADMIN_TOOLS,
        tool_choice: 'auto',
      });

      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error('Respuesta vacía del modelo en adminHandler.');
      }

      messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        const finalReply =
          assistantMessage.content?.trim() || 'Listo, operación procesada.';
        await sendWhatsAppText(from, finalReply);
        return;
      }

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') continue;

        const toolOutput = await executeAdminTool(
          toolCall.function.name,
          toolCall.function.arguments
        );

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolOutput,
        });
      }
    }

    await sendWhatsAppText(
      from,
      'Completé las operaciones solicitadas. ¿Necesitas gestionar algo más?'
    );
  } catch (error) {
    console.error('[AdminHandler] Error procesando mensaje del administrador:', error);
    await sendWhatsAppText(
      from,
      '⚠️ Ocurrió un error interno procesando tu instrucción. Por favor, inténtalo de nuevo.'
    );
  }
}