const GRAPH_API_VERSION = 'v22.0';
const GRAPH_API_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

type WhatsAppApiError = {
  error?: { message?: string; type?: string; code?: number };
};

function getWhatsAppConfig() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required.');
  }
  return { token, phoneNumberId };
}

async function graphFetch(url: string, init: RequestInit): Promise<Response> {
  const { token } = getWhatsAppConfig();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as WhatsAppApiError;
    throw new Error(body.error?.message ?? `WhatsApp API error (${response.status}).`);
  }
  return response;
}

export async function sendWhatsAppText(to: string, body: string): Promise<string> {
  const { phoneNumberId } = getWhatsAppConfig();
  const response = await graphFetch(`${GRAPH_API_BASE_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body },
    }),
  });
  const payload = (await response.json()) as { messages?: Array<{ id?: string }> };
  const messageId = payload.messages?.[0]?.id;
  if (!messageId) throw new Error('WhatsApp did not return a message ID.');
  return messageId;
}

export async function markWhatsAppMessageAsRead(messageId: string): Promise<void> {
  const { phoneNumberId } = getWhatsAppConfig();
  await graphFetch(`${GRAPH_API_BASE_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  });
}

/** Downloads a WhatsApp media object and returns its bytes plus its MIME type. */
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const metadataResponse = await graphFetch(`${GRAPH_API_BASE_URL}/${mediaId}`, { method: 'GET' });
  const metadata = (await metadataResponse.json()) as { url?: string; mime_type?: string };
  if (!metadata.url) throw new Error('WhatsApp media URL was not returned.');

  const binaryResponse = await graphFetch(metadata.url, { method: 'GET' });
  return {
    buffer: Buffer.from(await binaryResponse.arrayBuffer()),
    mimeType: metadata.mime_type ?? binaryResponse.headers.get('content-type') ?? 'application/octet-stream',
  };
}
// Asegúrate de tener esta importación arriba en src/lib/whatsapp.ts:
import { supabaseAdmin } from '@/lib/supabase';

/**
 * Envía una plantilla aprobada de Meta (necesario cuando pasan más de 24h del último mensaje del paciente).
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  bodyParameters: string[],
  languageCode = 'es_MX'
): Promise<string> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    throw new Error('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID.');
  }

  const response = await fetch(
    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: [
            {
              type: 'body',
              parameters: bodyParameters.map((text) => ({
                type: 'text',
                text,
              })),
            },
          ],
        },
      }),
    }
  );

  const data = (await response.json()) as {
    messages?: Array<{ id: string }>;
    error?: { message: string };
  };

  if (!response.ok) {
    throw new Error(`Error enviando plantilla WhatsApp: ${data.error?.message ?? response.statusText}`);
  }

  return data.messages?.[0]?.id ?? '';
}

/**
 * Notifica al paciente la cancelación de su cita respetando la ventana de 24h de Meta
 * y guarda el aviso en `chat_messages` para mantener el contexto si desea reagendar.
 */
export async function notifyPatientCancellation(params: {
  patientPhone: string;
  patientName: string;
  appointmentDateText: string;
  reason?: string;
}): Promise<void> {
  const { patientPhone, patientName, appointmentDateText, reason } = params;

  // Revisar cuándo fue el último mensaje entrante del paciente
  const { data: lastUserMsg } = await supabaseAdmin
    .from('chat_messages')
    .select('created_at')
    .eq('patient_phone', patientPhone)
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const isWithin24Hours =
    lastUserMsg?.created_at &&
    Date.now() - new Date(lastUserMsg.created_at).getTime() < 23.5 * 60 * 60 * 1000;

  const reasonText = reason?.trim()
    ? `debido a: ${reason.trim()}`
    : 'por un ajuste en la agenda de la clínica';

  const messageText = `Hola ${patientName}, te informamos que tu cita programada para el ${appointmentDateText} tuvo que ser cancelada ${reasonText}. Disculpa las molestias. ¿Te gustaría que revisemos horarios disponibles para reagendarla?`;

  if (isWithin24Hours) {
    await sendWhatsAppText(patientPhone, messageText);
  } else {
    try {
      await sendWhatsAppTemplate(patientPhone, 'cita_cancelada_clinica', [
        patientName,
        appointmentDateText,
        reason?.trim() || 'ajustes en la agenda',
      ]);
    } catch (templateError) {
      console.warn(
        '[WhatsApp] Falló plantilla cita_cancelada_clinica, intentando texto directo:',
        templateError
      );
      await sendWhatsAppText(patientPhone, messageText);
    }
  }

  // Guardar en chat_messages para que la IA tenga contexto cuando el paciente responda
  await supabaseAdmin.from('chat_messages').insert({
    patient_phone: patientPhone,
    role: 'assistant',
    content: messageText,
  });
}
