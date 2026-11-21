export interface WhatsAppListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

export class WhatsAppError extends Error {
  constructor(readonly status: number, readonly code?: number) {
    super(`WhatsApp request rejected (${status}, code ${code ?? 'unknown'})`);
  }
}

export function phoneDigits(value: string | undefined): string {
  return (value ?? '').replace(/[\s()+-]/g, '');
}

export function isWhatsAppPhone(value: string): boolean {
  return /^[1-9]\d{7,14}$/.test(value);
}

export function parseClinicWhatsApp(value: string): string | null {
  const input = value.trim();
  if (!/^\+?[\d\s()-]+$/.test(input)) return null;
  const digits = phoneDigits(input);
  const phone = !input.startsWith('+') && /^\d{10}$/.test(digits) ? `52${digits}` : digits;
  return isWhatsAppPhone(phone) ? phone : null;
}

export function comparableWhatsApp(phone: string): string {
  return phone.replace(/^521(?=\d{10}$)/, '52');
}

export function shorten(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${prefix.trimEnd()}…`;
}

export const graphUrl = () => `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`;

export function whatsAppToken(): string {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('WHATSAPP_TOKEN is missing');
  return token;
}

async function sendWhatsAppRequest(to: string, body: Record<string, unknown>): Promise<string> {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!phoneId || !isWhatsAppPhone(to)) throw new Error('Invalid WhatsApp configuration or destination');
  const response = await fetch(`${graphUrl()}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${whatsAppToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => null) as {
    error?: { code?: number }; messages?: Array<{ id?: string }>;
  } | null;
  if (!response.ok) throw new WhatsAppError(response.status, data?.error?.code);
  const id = data?.messages?.[0]?.id;
  if (!id) throw new Error('WhatsApp response did not include a message ID');
  return id;
}

export function sendWhatsAppText(to: string, body: string): Promise<string> {
  return sendWhatsAppRequest(to, { type: 'text', text: { body: shorten(body, 4096) } });
}

export function sendWhatsAppTemplate(to: string, name: string, values: string[], replies: string[] = []): Promise<string> {
  return sendWhatsAppRequest(to, {
    type: 'template',
    template: {
      name,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es_MX' },
      components: [{
        type: 'body',
        parameters: values.map(value => ({ type: 'text', text: value.replace(/\s+/g, ' ').trim() })),
      }, ...replies.map((payload, index) => ({
        type: 'button', sub_type: 'quick_reply', index: String(index),
        parameters: [{ type: 'payload', payload }],
      }))],
    },
  });
}

export function hasWhatsAppWindow(lastInbound: string | null | undefined) {
  const elapsed = Date.now() - Date.parse(lastInbound || '');
  return elapsed >= 0 && elapsed < 86_400_000;
}

export function sendWhatsAppInteractiveList(params: {
  to: string; bodyText: string; buttonText: string; sections: WhatsAppListSection[];
}): Promise<string> {
  const count = params.sections.reduce((total, section) => total + section.rows.length, 0);
  if (count < 1 || count > 10 || params.sections.some(section => !section.rows.length)) {
    throw new Error('WhatsApp lists require 1–10 rows');
  }
  return sendWhatsAppRequest(params.to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: shorten(params.bodyText, 1024) },
      action: {
        button: shorten(params.buttonText, 20),
        sections: params.sections.map(section => ({
          title: shorten(section.title, 24),
          rows: section.rows.map(row => ({
            id: row.id,
            title: shorten(row.title, 24),
            ...(row.description ? { description: shorten(row.description, 72) } : {}),
          })),
        })),
      },
    },
  });
}

export function sendWhatsAppInteractiveButtons(params: {
  to: string; bodyText: string; buttons: Array<{ id: string; title: string }>;
}): Promise<string> {
  if (params.buttons.length < 1 || params.buttons.length > 3) throw new Error('WhatsApp allows 1–3 buttons');
  return sendWhatsAppRequest(params.to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: shorten(params.bodyText, 1024) },
      action: { buttons: params.buttons.map(({ id, title }) => ({ type: 'reply', reply: { id, title: shorten(title, 20) } })) },
    },
  });
}
