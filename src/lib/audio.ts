/** Transcribes an OGG/Opus WhatsApp voice note with OpenAI Whisper. */
export async function transcribeWhatsAppAudio(audio: Buffer): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to transcribe audio.');

  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'voice-note.ogg');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Audio transcription failed (${response.status}): ${await response.text()}`);
  }
  const result = (await response.json()) as { text?: string };
  if (!result.text?.trim()) throw new Error('The audio transcription did not contain text.');
  return result.text.trim();
}
