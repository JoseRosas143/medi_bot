import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { handlePatientMessage, handleAdminMessage } from '@/lib/message-handlers';
import { supabaseAdmin as db } from '@/lib/supabase';
import { transcribeWhatsAppAudio } from '@/lib/audio';
import { recordNoticeStatus } from '@/lib/appointment-notices';
import { isWhatsAppPhone, phoneDigits, sendWhatsAppText } from '@/lib/whatsapp';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Reply = { id?: string; title?: string };
type WhatsAppMessage = {
  id: string; from: string; timestamp?: string; type: string;
  context?: { id?: string }; text?: { body?: string }; audio?: { id?: string };
  interactive?: { list_reply?: Reply; button_reply?: Reply };
};
type WhatsAppPayload = {
  object?: string;
  entry?: Array<{ changes?: Array<{ field?: string; value?: {
    metadata?: { phone_number_id?: string; display_phone_number?: string }; messages?: WhatsAppMessage[];
    statuses?: Array<{ id: string; status: string }>;
  } }> }>;
};

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  const challenge = params.get('hub.challenge');
  if (token && challenge && params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === token) {
    return new NextResponse(challenge);
  }
  return new NextResponse('Forbidden', { status: 403 });
}

function validSignature(body: Buffer, signature: string | null, secret: string) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), createHmac('sha256', secret).update(body).digest());
}

async function processMessage(message: WhatsAppMessage, displayNumber?: string) {
  if (!message.id || !isWhatsAppPhone(message.from)) return;
  const normalizedNumber = (number: string | undefined) => phoneDigits(number).replace(/^521(?=\d{10}$)/, '52');
  if (normalizedNumber(message.from) === normalizedNumber(displayNumber)) return;
  const sentAt = Number(message.timestamp) * 1000;
  if (Number.isFinite(sentAt) && sentAt > 0 && Date.now() - sentAt >= 86_400_000) return;
  const reply = message.interactive?.list_reply || message.interactive?.button_reply;
  const text = message.type === 'text' ? message.text?.body : message.type === 'interactive' ? reply?.title : undefined;
  const mediaId = message.type === 'audio' ? message.audio?.id : undefined;
  if (!text?.trim() && !mediaId && !reply?.id) return;
  const { error } = await db.from('whatsapp_receipts').insert({ message_id: message.id });
  if (error?.code === '23505') return;
  if (error) throw error;

  let state = 'processed';
  try {
    let content = text?.trim() || '';
    if (mediaId) {
      try {
        content = await transcribeWhatsAppAudio(mediaId);
      } catch {
        await sendWhatsAppText(message.from, 'No pude entender la nota de voz. ¿Puedes escribir tu mensaje o grabarlo de nuevo?');
        await db.from('whatsapp_receipts').update({ status: 'failed' }).eq('message_id', message.id).throwOnError();
        return;
      }
    }
    const payload = {
      from: message.from, messageId: message.id, content, optionId: reply?.id,
      contextMessageId: message.context?.id, timestamp: message.timestamp,
    };
    if (message.from === phoneDigits(process.env.ADMIN_PHONE_NUMBER)) await handleAdminMessage(payload);
    else await handlePatientMessage(payload);
  } catch (error) {
    state = 'failed';
    console.error('WhatsApp handler failed', { type: message.type, error: error instanceof Error ? error.name : 'database' });
    await sendWhatsAppText(message.from, 'Tu solicitud quedó sin confirmar. Si era sobre una cita, consulta su estado antes de volver a intentarlo.')
      .catch(() => undefined);
  }

  await db.from('whatsapp_receipts').update({ status: state }).eq('message_id', message.id).throwOnError();
}

export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !process.env.WHATSAPP_PHONE_NUMBER_ID) return new NextResponse('Unavailable', { status: 503 });
  const raw = Buffer.from(await request.arrayBuffer());
  if (!validSignature(raw, request.headers.get('x-hub-signature-256'), secret)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  let body: WhatsAppPayload;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { return new NextResponse('Invalid JSON', { status: 400 }); }
  if (body?.object !== 'whatsapp_business_account') return new NextResponse('Not Found', { status: 404 });

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (change.field !== 'messages' || value?.metadata?.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID) continue;
        for (const status of value.statuses || []) await recordNoticeStatus(status.id, status.status);
        for (const message of value.messages || []) await processMessage(message, value.metadata.display_phone_number);
      }
    }
    return NextResponse.json({ status: 'ok' });
  } catch {
    console.error('WhatsApp webhook could not persist processing state');
    return new NextResponse('Unavailable', { status: 503 });
  }
}
