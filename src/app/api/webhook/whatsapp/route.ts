import { NextResponse } from 'next/server';
import { handleAdminMessage, handlePatientMessage } from '@/lib/message-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body.object !== 'whatsapp_business_account') {
      return new NextResponse('Not Found', { status: 404 });
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const msg = value?.messages?.[0];

    if (!msg) {
      return new NextResponse('OK', { status: 200 });
    }

    const from = msg.from;
    const messageId = msg.id;
    const contextMessageId = msg.context?.id;

    let content = '';

    if (msg.type === 'text' && msg.text?.body) {
      content = msg.text.body;
    } else if (msg.type === 'interactive') {
      content = msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title || '';
    }

    if (!content) {
      return new NextResponse('OK', { status: 200 });
    }

    const incomingPayload = {
      from,
      messageId,
      content,
      contextMessageId,
    };

    if (from === process.env.ADMIN_PHONE_NUMBER) {
      await handleAdminMessage(incomingPayload);
    } else {
      await handlePatientMessage(incomingPayload);
    }

    return new NextResponse('OK', { status: 200 });
  } catch (error) {
    console.error('[WhatsApp Webhook Error]:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}