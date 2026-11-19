import { NextResponse } from 'next/server';
import { handlePatientMessage, handleAdminMessage } from '@/lib/message-handlers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (message) {
        const from = message.from;
        const messageId = message.id;
        const contextMessageId = message.context?.id;
        
        let content = '';

        // 1. Extraer texto normal
        if (message.type === 'text') {
          content = message.text.body;
        } 
        // 2. Extraer clics en botones o listas interactivas (¡Esto arregla el bucle!)
        else if (message.type === 'interactive') {
          content = message.interactive?.list_reply?.title || message.interactive?.button_reply?.title || '';
        } 
        // 3. Soporte para audios
        else if (message.type === 'audio') {
          content = '[Nota de voz recibida - Requiere procesamiento de audio]';
        }

        // Si hay un mensaje válido, procesarlo
        if (content) {
          const incomingMessage = { from, messageId, content, contextMessageId };

          if (from === process.env.ADMIN_PHONE_NUMBER) {
            await handleAdminMessage(incomingMessage);
          } else {
            await handlePatientMessage(incomingMessage);
          }
        }
      }
      return NextResponse.json({ status: 'ok' });
    }
    
    return new NextResponse('Not Found', { status: 404 });
  } catch (error) {
    console.error('Webhook Error:', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}