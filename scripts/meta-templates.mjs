const { WHATSAPP_TOKEN, WHATSAPP_WABA_ID, WHATSAPP_GRAPH_VERSION = 'v21.0' } = process.env;
if (!WHATSAPP_TOKEN || !/^\d+$/.test(WHATSAPP_WABA_ID || '')) {
  console.error('Configura WHATSAPP_TOKEN y WHATSAPP_WABA_ID antes de consultar Meta.');
  process.exit(1);
}

const templates = process.argv.includes('--booking-alerts') ? [
  {
    name: 'cita_adelanto_lista_espera',
    text: 'Se liberó un horario en {{1}} el {{2}}. Responde antes de que pasen 30 minutos o comience la cita. Conservas tu horario actual hasta que se confirme el cambio.',
    examples: ['J R Dental', 'viernes, 20 de noviembre de 2026, 16:00'],
    buttons: ['Aceptar horario', 'Conservar mi cita'],
  },
  {
    name: 'cita_nueva_recepcion',
    text: 'Nueva reserva en {{1}} para el {{2}}. Estado de agenda: {{3}}. Consulta la agenda de recepción para ver los detalles.',
    examples: ['J R Dental', 'viernes, 20 de noviembre de 2026, 16:00', 'Para hoy'],
  },
] : process.argv.includes('--clinic-tasks') ? [
  {
    name: 'pendiente_clinica_recordatorio',
    text: 'Tienes un recordatorio para el pendiente interno número {{1}}. Responde Pendientes para ver tus tareas abiertas.',
    examples: ['42'],
  },
] : [
  {
    name: 'cita_recordatorio',
    text: 'Hola, {{1}}. {{2}} te recuerda que tienes una cita el {{3}}. Si necesitas cambiarla, responde a este mensaje.',
    examples: ['Ana Demo', 'J R Dental', 'viernes, 20 de noviembre de 2026, 16:00'],
  },
  {
    name: 'cita_cancelada_clinica',
    text: 'Hola, {{1}}. {{2}} canceló tu cita del {{3}}. Si deseas reservar otro horario, responde a este mensaje.',
    examples: ['Ana Demo', 'J R Dental', 'viernes, 20 de noviembre de 2026, 16:00'],
  },
];

if (process.argv.includes('--handoff')) {
  templates.push({
    name: 'atencion_pendiente_clinica',
    text: 'Tienes una solicitud pendiente de atención por WhatsApp en {{1}}. Responde a este aviso para continuar.',
    examples: ['J R Dental'],
  });
}

const endpoint = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${WHATSAPP_WABA_ID}/message_templates`;
const headers = { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' };
const submit = process.argv.includes('--submit');
const language = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es_MX';

async function request(url, options) {
  const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Meta HTTP ${response.status} · código ${data.error?.code ?? 'desconocido'}${data.error?.error_subcode ? `/${data.error.error_subcode}` : ''}`);
  }
  return data;
}

for (const { name, text, examples, buttons } of templates) {
  try {
    const existing = await request(`${endpoint}?name=${name}&fields=name,language,status,category,components`);
    const found = existing.data?.find(template => template.name === name && template.language === language);
    if (found) {
      const body = found.components?.find(component => component.type === 'BODY');
      const existingButtons = found.components?.find(component => component.type === 'BUTTONS')?.buttons ?? [];
      const compatible = body?.text === text && found.category === 'UTILITY' &&
        existingButtons.length === (buttons?.length ?? 0) &&
        existingButtons.every((button, index) => button.type === 'QUICK_REPLY' && button.text === buttons?.[index]);
      console.log(`${name} (${language}): ${found.status}${compatible ? '' : ' · revisa el texto o la categoría existentes'}`);
      if (!compatible) process.exitCode = 1;
    } else if (submit) {
      const created = await request(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          name, language, category: 'UTILITY', parameter_format: 'POSITIONAL',
          components: [
            { type: 'BODY', text, example: { body_text: [examples] } },
            ...(buttons ? [{ type: 'BUTTONS', buttons: buttons.map(text => ({ type: 'QUICK_REPLY', text })) }] : []),
          ],
        }),
      });
      console.log(`${name} (${language}): ${created.status || 'recibida por Meta'}`);
    } else {
      console.log(`${name} (${language}): todavía no existe`);
    }
  } catch (error) {
    console.error(`${name}: ${error.message}`);
    process.exitCode = 1;
  }
}
