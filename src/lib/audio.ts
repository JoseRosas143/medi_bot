import { graphUrl, whatsAppToken } from '@/lib/whatsapp';

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const audioFormats: Record<string, string> = {
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/wav': 'wav',
};

export async function transcribeWhatsAppAudio(mediaId: string): Promise<string> {
  if (!/^\d+$/.test(mediaId)) throw new Error('Invalid media ID');
  const headers = { Authorization: `Bearer ${whatsAppToken()}` };
  const metadataResponse = await fetch(`${graphUrl()}/${mediaId}?phone_number_id=${encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID || '')}`, {
    headers, signal: AbortSignal.timeout(8_000),
  });
  if (!metadataResponse.ok) throw new Error(`WhatsApp media lookup failed (${metadataResponse.status})`);
  const metadata = await metadataResponse.json() as { url: string; mime_type?: string; file_size?: number };
  const mime = metadata.mime_type?.split(';')[0] || '';
  const extension = audioFormats[mime];
  if (!extension || extension === 'amr' || extension === 'aac' || Number(metadata.file_size) > MAX_AUDIO_BYTES) {
    throw new Error('Unsupported audio format or size');
  }

  const url = new URL(metadata.url);
  if (url.protocol !== 'https:' || url.hostname !== 'lookaside.fbsbx.com' || url.port || url.username || url.password) {
    throw new Error('Unexpected WhatsApp media host');
  }
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new Error(`WhatsApp media download failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_AUDIO_BYTES) {
      await reader.cancel();
      throw new Error('WhatsApp audio is too large');
    }
    chunks.push(new Uint8Array(value));
  }
  if (size === 0) throw new Error('Empty WhatsApp audio');

  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is missing');
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('language', 'es');
  form.append('file', new Blob(chunks, { type: mime }), `voice-note.${extension}`);
  const result = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!result.ok) throw new Error(`Audio transcription failed (${result.status})`);
  const data = (await result.json()) as { text?: string };
  const transcript = data.text?.trim();
  if (!transcript) throw new Error('No speech detected');
  return transcript.slice(0, 3500);
}
