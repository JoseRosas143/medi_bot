import { after } from 'next/server';

import { transcribeWhatsAppAudio } from '@/lib/audio';
import { handleAdminMessage, handlePatientMessage, type IncomingMessage } from '@/lib/message-handlers';
import { downloadWhatsAppMedia, markWhatsAppMessageAsRead } from '@/lib/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WhatsAppMessage = {
  from?: string;
  id?: string;
  type?: 'text' | 'audio' | string;
  text?: { body?: string };
  audio?: { id?: string };
  context?: { id?: string };
};

type WhatsAppWebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
};

function verifyRequest(request: Request): Response {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

async function toIncomingMessage(message: WhatsAppMessage): Promise<IncomingMessage | null> {
  if (!message.from || !message.id) return null;

  let content: string | undefined;
  if (message.type === 'text') {
    content = message.text?.body?.trim();
  } else if (message.type === 'audio' && message.audio?.id) {
    const { buffer } = await downloadWhatsAppMedia(message.audio.id);
    content = await transcribeWhatsAppAudio(buffer);
  }
  if (!content) return null;

  return {
    from: message.from,
    messageId: message.id,
    content,
    contextMessageId: message.context?.id,
  };
}

async function processWebhook(payload: WhatsAppWebhookPayload): Promise<void> {
  const messages = payload.entry?.flatMap((entry) =>
    entry.changes?.flatMap((change) => change.value?.messages ?? []) ?? [],
  ) ?? [];

  // `statuses` are deliberately ignored: only `messages` reach this point.
  for (const rawMessage of messages) {
    try {
      const message = await toIncomingMessage(rawMessage);
      if (!message) continue;

      await markWhatsAppMessageAsRead(message.messageId);
      if (message.from === process.env.ADMIN_PHONE_NUMBER) {
        await handleAdminMessage(message);
      } else {
        await handlePatientMessage(message);
      }
    } catch (error) {
      // Meta retries webhook deliveries when a non-2xx response is returned.
      // Log failures while preserving the 200 acknowledgement to prevent retry storms.
      console.error('Failed to process WhatsApp webhook message:', error);
    }
  }
}

export function GET(request: Request): Response {
  return verifyRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  let payload: WhatsAppWebhookPayload;
  try {
    payload = (await request.json()) as WhatsAppWebhookPayload;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Acknowledge Meta immediately; `after` keeps the work attached to this request lifecycle.
  after(async () => {
    await processWebhook(payload);
  });
  return Response.json({ received: true }, { status: 200 });
}
