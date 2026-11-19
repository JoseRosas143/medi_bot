import { NextResponse } from 'next/server';
import { handlePatientMessage, handleAdminMessage } from '@/lib/message-handlers';

export const dynamic = 'force-dynamic';

// Memoria temporal en el servidor para evitar procesar mensajes duplicados (reintentos de WhatsApp)
const processedMessages = new Set<string>();

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
        const messageId = message.id;

        // --- SISTEMA DE DEDUPLICACIÓN ---
        // Si ya vimos este ID de mensaje en los últimos minutos, lo ignoramos para evitar que la IA se vuelva loca
        if (processedMessages.has(messageId)) {
          return NextResponse.json({ status: 'ignored_duplicate' });
        }
        
        // Guardamos el ID del mensaje y limitamos el tamaño de la memoria para que el servidor no se sature
        processedMessages.add(messageId);
        if (processedMessages.size > 1000) {
          processedMessages.clear();
        }

        const from = message.from;
        const contextMessageId = message.context?.id;
        
        let content = '';

        // 1. Extraer texto normal
        if (message.type === 'text') {
          content = message.text.body;
        } 
        // 2. Extraer clics en botones o listas interactivas
        else if (message.type === 'interactive') {
          content = message.interactive?.list_reply?.title || message.interactive?.button_reply?.title || '';
        } 
        // 3. Soporte para audios (opcional a futuro)
        else if (message.type === 'audio') {
          content = '[Nota de voz recibida - Requiere procesamiento de audio]';
        }

        // Si extrajimos contenido válido, se lo pasamos al agente correspondiente
        if (content) {
          const incomingMessage = { from, messageId, content, contextMessageId };

          // IMPORTANTE: Responder con 200 INMEDIATAMENTE para que WhatsApp no haga reintentos,
          // y ejecutar la IA de forma asíncrona sin bloquear la respuesta.
          if (from === process.env.ADMIN_PHONE_NUMBER) {
            handleAdminMessage(incomingMessage).catch(console.error);
          } else {
            handlePatientMessage(incomingMessage).catch(console.error);
          }
        }
      }
      
      // WhatsApp exige un 200 OK rápido para no volver a enviar el webhook
      return NextResponse.json({ status: 'ok' });
    }
    
    return new NextResponse('Not Found', { status: 404 });
  } catch (error) {
    console.error('Webhook Error:', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}