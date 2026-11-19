import { randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase';
import { getPatientAppointments } from '@/lib/calendar';
import { clinicName, formatAppointment } from '@/lib/clinic-time';
import { handleAppointmentAction } from '@/lib/appointment-actions';
import { runAdminAgent, showSchedule } from '@/lib/handlers/adminHandler';
import { runPatientAgent } from '@/lib/handlers/patientHandler';
import { botName, catalogDetail, normalized, showAdminMenu, showCatalog, showPatientMenu } from '@/lib/menus';
import { isWhatsAppPhone, phoneDigits, sendWhatsAppInteractiveButtons, sendWhatsAppTemplate, sendWhatsAppText, WhatsAppError } from '@/lib/whatsapp';

export type IncomingMessage = {
  from: string;
  messageId: string;
  content: string;
  optionId?: string;
  contextMessageId?: string;
  timestamp?: string;
};

const menuRequests = new Set(['hola', 'menu', 'ayuda', 'inicio', 'opciones', 'menu principal']);
const closeRequests = new Set(['cerrar', 'cerrar conversacion', 'listo']);
const emergencyWords = /no puedo respirar|dificultad para respirar|sangrado (?:abundante|incontrolable)|sangrado que no (?:se detiene|para)|dolor de pecho|perdi el conocimiento/;
const humanRequest = /^(?:(?:quiero|necesito|puedo)\s+)?hablar con (?:el |la |un |una )?(?:doctor|doctora|dentista|especialista|humano|recepcion)$/;

async function history(phone: string, role: 'user' | 'assistant' | 'doctor', content: string) {
  await db.from('chat_messages').insert({ patient_phone: phone, role, content }).throwOnError();
}

function parseName(content: string) {
  const name = content.trim().replace(/^(?:hola[,.!]?\s*)?(?:me llamo|mi nombre es|soy)\s+/i, '').trim().replace(/[.!]$/, '');
  if (name.length < 2 || name.length > 90 || !/^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+)*$/u.test(name)) return null;
  if (/\b(?:cita|ayuda|hola|urgencia|agenda|doctor|precio|necesito|tratamiento|menu|quiero|gracias|dolor|reserva)\b/i.test(normalized(name))) return null;
  return name;
}

type HumanPatient = { phone: string; full_name: string | null; chat_mode: string; human_session_id: string | null };

function inboundTime(timestamp: string | undefined) {
  const millis = Number(timestamp) * 1000;
  return new Date(Number.isFinite(millis) && millis > 0 ? Math.min(millis, Date.now()) : Date.now()).toISOString();
}

async function closeHumanChat(patient: HumanPatient) {
  let update = db.from('patients').update({ chat_mode: 'AI_ACTIVE', human_session_id: null })
    .eq('phone', patient.phone).eq('chat_mode', 'WAITING_HUMAN');
  update = patient.human_session_id ? update.eq('human_session_id', patient.human_session_id) : update.is('human_session_id', null);
  const { data } = await update.select('phone').maybeSingle().throwOnError();
  return !!data;
}

async function notifyDoctor(patient: HumanPatient, content: string) {
  const admin = phoneDigits(process.env.ADMIN_PHONE_NUMBER);
  if (!isWhatsAppPhone(admin)) return false;
  const template = process.env.WHATSAPP_HANDOFF_TEMPLATE;
  const { data: settings } = await db.from('bot_settings').select('admin_last_inbound_at').eq('id', 1).single().throwOnError();
  const lastInbound = settings?.admin_last_inbound_at;
  const outsideWindow = !lastInbound || Date.now() - Date.parse(lastInbound) >= 86_400_000;
  let id: string;
  if (outsideWindow) {
    if (!template) return false;
    id = await sendWhatsAppTemplate(admin, template, [clinicName()]);
  } else {
    try {
      id = await sendWhatsAppText(admin, `🩺 *Atención por WhatsApp*\n${patient.full_name || 'Paciente'}\n\n${content}\n\nDesliza este mensaje para responder o escribe «cerrar» como respuesta.`);
    } catch (error) {
      if (!(error instanceof WhatsAppError) || error.code !== 131047) throw error;
      if (!template) return false;
      id = await sendWhatsAppTemplate(admin, template, [clinicName()]);
    }
  }
  await db.from('escalation_mappings').insert({
    wa_message_id: id, patient_phone: patient.phone, human_session_id: patient.human_session_id,
  }).throwOnError();
  return true;
}

export async function handlePatientMessage(message: IncomingMessage) {
  const { from, optionId, content } = message;
  const text = normalized(content);
  const { data: inserted } = await db.from('patients').upsert({ phone: from }, { onConflict: 'phone', ignoreDuplicates: true })
    .select('phone').maybeSingle().throwOnError();
  const { data: patient } = await db.from('patients').select('phone,full_name,chat_mode,human_session_id')
    .eq('phone', from).single().throwOnError();
  if (!patient) throw new Error('Missing patient after upsert');

  const inboundAt = inboundTime(message.timestamp);
  await db.from('patients').update({ last_inbound_at: inboundAt }).eq('phone', from)
    .or(`last_inbound_at.is.null,last_inbound_at.lt.${inboundAt}`).throwOnError();
  const reply = async (body: string) => {
    await sendWhatsAppText(from, body);
    await history(from, 'assistant', body);
  };

  if (emergencyWords.test(text)) {
    await reply('Si tienes dificultad para respirar, dolor de pecho, pérdida del conocimiento o un sangrado que no se detiene, llama a emergencias o acude a urgencias de inmediato.');
    return;
  }

  if (patient.chat_mode === 'WAITING_HUMAN') {
    if (!optionId && closeRequests.has(text)) {
      if (await closeHumanChat(patient)) await showPatientMenu(from);
      return;
    }
    if (optionId) {
      await reply('Tu conversación está con el equipo de la clínica. Escribe tu mensaje o «cerrar» para volver al menú.');
      return;
    }
    await history(from, 'user', content);
    if (!(await notifyDoctor(patient, content))) {
      await reply('El equipo aún no está disponible por WhatsApp. Escribe «cerrar» para volver al menú.');
    }
    return;
  }

  if (optionId === 'doctor' || optionId === 'urgencia' || humanRequest.test(text) || text === 'atencion prioritaria') {
    const sessionId = randomUUID();
    const { data } = await db.from('patients').update({ chat_mode: 'WAITING_HUMAN', human_session_id: sessionId })
      .eq('phone', from).eq('chat_mode', 'AI_ACTIVE').select('phone').maybeSingle().throwOnError();
    if (!data) return;
    const session = { ...patient, human_session_id: sessionId };
    const notified = await notifyDoctor(session, optionId === 'urgencia' || text === 'atencion prioritaria'
      ? 'Solicitó atención prioritaria.' : 'Solicitó hablar con el equipo.').catch(async error => {
      await closeHumanChat(session);
      throw error;
    });
    if (!notified) {
      await closeHumanChat(session);
      await reply('El equipo aún no está disponible por WhatsApp. Si necesitas atención inmediata, contacta a la clínica por teléfono.');
      return;
    }
    await reply('Solicité atención al equipo. Puedes escribir aquí o enviar «cerrar» para volver al menú.');
    return;
  }

  const fullName = patient.full_name?.trim();
  if (!fullName) {
    const name = !optionId && (!inserted || /^(?:soy|me llamo|mi nombre es)\s/.test(text)) ? parseName(content) : null;
    if (!name) {
      await reply(`Hola, soy *${botName()}*, de *${clinicName()}*. ¿Cómo te llamas?`);
      return;
    }
    let update = db.from('patients').update({ full_name: name, onboarding_completed: true }).eq('phone', from);
    update = patient.full_name === null ? update.is('full_name', null) : update.eq('full_name', patient.full_name);
    const { data } = await update.select('full_name').maybeSingle().throwOnError();
    if (data) await showPatientMenu(from, name.split(/\s+/)[0]);
    return;
  }
  if (await handleAppointmentAction(from, optionId, false)) return;
  if (optionId === 'menu_principal' || (!optionId && menuRequests.has(text))) return showPatientMenu(from, fullName.split(/\s+/)[0]);
  if (optionId === 'menu_tratamientos' || ['tratamientos', 'tratamientos y precios', 'tratamientos/precios'].includes(text)) return showCatalog(from, 'treatments');
  if (optionId === 'menu_faqs' || ['preguntas frecuentes', 'info y politicas'].includes(text)) return showCatalog(from, 'faqs');
  const catalogOption = optionId?.match(/^(trt|faq)_(page_)?(\d{1,9})$/);
  if (catalogOption) {
    const catalog = catalogOption[1] === 'trt' ? 'treatments' : 'faqs';
    const id = Number(catalogOption[3]);
    if (catalogOption[2]) await showCatalog(from, catalog, id);
    else {
      const detail = await catalogDetail(catalog, id) || 'Esta opción ya no está disponible.';
      if (detail.length > 1024) {
        await reply(detail);
        await showCatalog(from, catalog);
        return;
      }
      await sendWhatsAppInteractiveButtons({
        to: from, bodyText: detail, buttons: [
          { id: catalog === 'treatments' ? 'menu_tratamientos' : 'menu_faqs', title: 'Volver al listado' },
          { id: 'menu_principal', title: 'Menú principal' },
        ],
      });
      await history(from, 'assistant', detail);
    }
    return;
  }
  if (optionId === 'agendar' || text === 'agendar cita') {
    await history(from, 'user', 'Quiero agendar una cita.');
    await reply('¿Qué día y a qué hora te gustaría venir? Por ejemplo, «mañana a las 4 p. m.».');
    return;
  }
  if (optionId === 'cancelar' || text === 'mis citas') {
    const events = (await getPatientAppointments(from)).slice(0, 10);
    await history(from, 'user', 'Quiero consultar mis citas.');
    await reply(events.length ? `🗓️ *Tus próximas citas*\n${events.map(event => `• ${formatAppointment(event.start)}`).join('\n')}\n\nSi quieres cancelar, dime cuál.` : 'No encontré citas futuras asociadas a tu WhatsApp.');
    return;
  }
  if (optionId) return showPatientMenu(from);
  await history(from, 'user', content);
  await runPatientAgent(from, fullName, reply);
}

const adminPrompts: Record<string, string> = {
  admin_cancelar: 'Dime la fecha y el nombre o la hora. Por ejemplo, «Cancela la cita de Ana de mañana a las 4 p. m.».',
  admin_task: 'Escribe «Anota como pendiente» y lo que hay que hacer.',
  admin_cerrar_chat: 'Responde al mensaje del paciente con «cerrar» para terminar su chat.',
  adm_add_treatment: 'Dime el nombre y el precio en MXN. Por ejemplo, «Agrega Limpieza por 500 pesos».',
  adm_edit_treatment: 'Escribe «Actualiza Limpieza a 550 pesos» o «Retira Limpieza», según el cambio.',
  adm_add_faq: 'Escribe la pregunta y su respuesta en el mismo mensaje.',
  adm_edit_faq: 'Escribe la pregunta y la nueva respuesta, o indica que quieres retirarla.',
};

export async function handleAdminMessage(message: IncomingMessage) {
  const { from, content, optionId, contextMessageId } = message;
  const text = normalized(content);
  const inboundAt = inboundTime(message.timestamp);
  await db.from('bot_settings').update({ admin_last_inbound_at: inboundAt }).eq('id', 1)
    .or(`admin_last_inbound_at.is.null,admin_last_inbound_at.lt.${inboundAt}`).throwOnError();
  if (contextMessageId && !optionId) {
    const { data: mapping } = await db.from('escalation_mappings').select('patient_phone,human_session_id')
      .eq('wa_message_id', contextMessageId).maybeSingle().throwOnError();
    if (mapping) {
      const { data: patient } = await db.from('patients').select('phone,full_name,chat_mode,human_session_id,last_inbound_at')
        .eq('phone', mapping.patient_phone).maybeSingle().throwOnError();
      if (!patient || patient.chat_mode !== 'WAITING_HUMAN' || patient.human_session_id !== mapping.human_session_id) {
        await sendWhatsAppText(from, 'Esa conversación ya está cerrada.');
        return;
      }
      const expired = patient.last_inbound_at && Date.now() - Date.parse(patient.last_inbound_at) >= 86_400_000;
      if (closeRequests.has(text)) {
        if (await closeHumanChat(patient)) {
          await sendWhatsAppText(from, 'Conversación cerrada.');
          if (!expired) await sendWhatsAppText(patient.phone, `El equipo cerró la conversación. Soy ${botName()} y vuelvo a atenderte.`)
            .catch(error => { if (!(error instanceof WhatsAppError) || error.code !== 131047) throw error; });
        }
        return;
      }
      try {
        if (expired) throw new WhatsAppError(400, 131047);
        await sendWhatsAppText(patient.phone, content);
      } catch (error) {
        if (!(error instanceof WhatsAppError) || error.code !== 131047) throw error;
        await sendWhatsAppText(from, 'La ventana de WhatsApp venció. El paciente necesita volver a escribir para que puedas responder.');
        return;
      }
      await history(patient.phone, 'doctor', content);
      await sendWhatsAppText(from, '✅ Mensaje enviado.');
      return;
    }
  }
  if (await handleAppointmentAction(from, optionId, true)) return;
  if (!optionId && menuRequests.has(text)) return showAdminMenu(from);
  if (optionId === 'admin_agenda' || text === 'agenda de hoy') return showSchedule(from);
  if (optionId && Object.hasOwn(adminPrompts, optionId)) {
    await sendWhatsAppText(from, adminPrompts[optionId]);
    return;
  }
  if (optionId) return showAdminMenu(from);
  await runAdminAgent(from, content);
}
