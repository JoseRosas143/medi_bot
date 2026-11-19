import { supabaseAdmin } from '@/lib/supabase';

export interface WhatsAppListRow {
  id: string;
  title: string;       // Máximo 24 caracteres
  description?: string; // Máximo 72 caracteres
}

export interface WhatsAppListSection {
  title: string;       // Máximo 24 caracteres
  rows: WhatsAppListRow[];
}

export async function sendWhatsAppText(to: string, body: string): Promise<string> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    throw new Error('Faltan credenciales de WhatsApp en variables de entorno.');
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
        type: 'text',
        text: { body },
      }),
    }
  );

  const data = (await response.json()) as {
    messages?: Array<{ id: string }>;
    error?: { message: string };
  };

  if (!response.ok) {
    throw new Error(`Error enviando mensaje de WhatsApp: ${data.error?.message ?? response.statusText}`);
  }

  return data.messages?.[0]?.id ?? '';
}

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

export async function sendWhatsAppInteractiveList(params: {
  to: string;
  bodyText: string;
  buttonText: string;
  sections: WhatsAppListSection[];
  footerText?: string;
}): Promise<string> {
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
        recipient_type: 'individual',
        to: params.to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: params.bodyText },
          ...(params.footerText ? { footer: { text: params.footerText } } : {}),
          action: {
            button: params.buttonText.slice(0, 20),
            sections: params.sections,
          },
        },
      }),
    }
  );

  const data = (await response.json()) as {
    messages?: Array<{ id: string }>;
    error?: { message: string };
  };

  if (!response.ok) {
    throw new Error(`Error enviando lista interactiva: ${data.error?.message ?? response.statusText}`);
  }

  return data.messages?.[0]?.id ?? '';
}

export async function notifyPatientCancellation(params: {
  patientPhone: string;
  patientName: string;
  appointmentDateText: string;
  reason?: string;
}): Promise<void> {
  const { patientPhone, patientName, appointmentDateText, reason } = params;

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
      console.warn('[WhatsApp] Falló plantilla cita_cancelada_clinica:', templateError);
      await sendWhatsAppText(patientPhone, messageText);
    }
  }

  await supabaseAdmin.from('chat_messages').insert({
    patient_phone: patientPhone,
    role: 'assistant',
    content: messageText,
  });
}