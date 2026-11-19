import { supabaseAdmin } from '@/lib/supabase';

export interface WhatsAppListRow {
  id: string;
  title: string;       // Máx 24 caracteres
  description?: string; 
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

async function sendWhatsAppRequest(phoneNumberId: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`API de Meta falló: ${(data as any).error?.message}`);
  return (data as any).messages?.[0]?.id ?? '';
}

export async function sendWhatsAppText(to: string, body: string): Promise<string> {
  const token = String(process.env.WHATSAPP_TOKEN);
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID);
  return sendWhatsAppRequest(phoneNumberId, token, {
    messaging_product: 'whatsapp', to, type: 'text', text: { body }
  });
}

export async function sendWhatsAppTemplate(to: string, templateName: string, bodyParameters: string[]): Promise<string> {
  const token = String(process.env.WHATSAPP_TOKEN);
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID);
  return sendWhatsAppRequest(phoneNumberId, token, {
    messaging_product: 'whatsapp', to, type: 'template',
    template: {
      name: templateName,
      language: { code: 'es_MX' },
      components: [{ type: 'body', parameters: bodyParameters.map((text) => ({ type: 'text', text })) }],
    },
  });
}

export async function sendWhatsAppInteractiveList(params: { to: string; bodyText: string; buttonText: string; sections: WhatsAppListSection[]; }): Promise<string> {
  const token = String(process.env.WHATSAPP_TOKEN);
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID);
  return sendWhatsAppRequest(phoneNumberId, token, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: params.to, type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: params.bodyText },
      action: { button: params.buttonText.slice(0, 20), sections: params.sections },
    },
  });
}

export async function sendWhatsAppInteractiveButtons(params: { to: string; bodyText: string; buttons: string[]; }): Promise<string> {
  const token = String(process.env.WHATSAPP_TOKEN);
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID);
  return sendWhatsAppRequest(phoneNumberId, token, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: params.to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: params.bodyText },
      action: {
        buttons: params.buttons.slice(0, 3).map((btn, i) => ({
          type: 'reply', reply: { id: `btn_${i}`, title: btn.slice(0, 20) }
        }))
      },
    },
  });
}