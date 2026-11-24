import { supabaseAdmin as db } from '@/lib/supabase';
import { clinicDate, clinicName, formatAppointment, nextDate } from '@/lib/clinic-time';
import { handleAppointmentAction, handleCancellationContactReply } from '@/lib/appointment-actions';
import { handleAdminAppointments } from '@/lib/appointment-admin';
import { handleBooking, startBooking } from '@/lib/booking';
import { handlePatientAppointments, showPatientAppointments } from '@/lib/patient-appointments';
import { completeClinicTask, showClinicTask, showPendingTasks } from '@/lib/clinic-tasks';
import { handleReceptionAction } from '@/lib/reception';
import { runAdminAgent, showAppointmentsByWhatsApp, showSchedule } from '@/lib/handlers/adminHandler';
import { runPatientAgent } from '@/lib/handlers/patientHandler';
import { handleTreatmentEditor } from '@/lib/treatment-editor';
import { handleWaitlistOffer, notifyAdminWaitlist } from '@/lib/waitlist';
import { handleAdminWaitlist } from '@/lib/waitlist-admin';
import { handleClinicAdministration, showPatientBalance } from '@/lib/clinic-admin';
import { botName, catalogDetail, normalized, sendCatalogDetail, showAdminFaqMenu, showAdminMenu, showAdminTreatmentMenu, showCatalog, showPatientMenu } from '@/lib/menus';
import { getSchedulableTreatment } from '@/lib/treatment-duration';
import { handlePatientNameCorrection } from '@/lib/patient-name';
import { handleReminderPreference } from '@/lib/reminder-preference';
import { closeHumanChat, openHumanChat, trackHumanChatReply, recordChatMessage as history, type HumanPatient } from '@/lib/human-chat';
import { hasWhatsAppWindow, isWhatsAppPhone, phoneDigits, sendWhatsAppTemplate, sendWhatsAppText, WhatsAppError } from '@/lib/whatsapp';

export type IncomingMessage = {
  from: string;
  messageId: string;
  content: string;
  optionId?: string;
  contextMessageId?: string;
  timestamp?: string;
};

const menuRequests = new Set(['hola', 'menu', 'ayuda', 'inicio', 'opciones', 'menu principal']);
const closeRequests = new Set(['cerrar', 'cerrar chat', 'cerrar conversacion', 'listo']);
const emergencyWords = /no puedo respirar|dificultad para respirar|sangrado (?:abundante|incontrolable)|sangrado que no (?:se detiene|para)|dolor de pecho|perdi el conocimiento/;
const humanRequest = /^(?:(?:quiero|necesito|puedo)\s+)?hablar con (?:el |la |un |una )?(?:doctor|doctora|dentista|especialista|humano|recepcion)$/;

function parseName(content: string) {
  const name = content.trim().replace(/^(?:hola[,.!]?\s*)?(?:me llamo|mi nombre es|soy)\s+/i, '').trim().replace(/[.!]$/, '');
  if (name.length < 2 || name.length > 90 || !/^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+)*$/u.test(name)) return null;
  if (/\b(?:cita|ayuda|hola|urgencia|agenda|doctor|precio|necesito|tratamiento|menu|quiero|gracias|dolor|reserva)\b/i.test(normalized(name))) return null;
  return name;
}

function inboundTime(timestamp: string | undefined) {
  const millis = Number(timestamp) * 1000;
  return new Date(Number.isFinite(millis) && millis > 0 ? Math.min(millis, Date.now()) : Date.now()).toISOString();
}

async function notifyDoctor(patient: HumanPatient, content: string) {
  const admin = phoneDigits(process.env.ADMIN_PHONE_NUMBER);
  if (!isWhatsAppPhone(admin)) return false;
  const template = process.env.WHATSAPP_HANDOFF_TEMPLATE?.trim() || 'solicitud_atencion_recepcion';
  const { data: settings } = await db.from('bot_settings').select('admin_last_inbound_at').eq('id', 1).single().throwOnError();
  const lastInbound = settings?.admin_last_inbound_at;
  const outsideWindow = !lastInbound || Date.now() - Date.parse(lastInbound) >= 86_400_000;
  let id: string;
  if (outsideWindow) {
    id = await sendWhatsAppTemplate(admin, template, [await clinicName()]);
  } else {
    try {
      id = await sendWhatsAppText(admin, `🩺 *Atención por WhatsApp*\n${patient.full_name || 'Paciente'}\n\n${content}\n\nDesliza este mensaje para responder o escribe «cerrar» como respuesta.`);
    } catch (error) {
      if (!(error instanceof WhatsAppError) || error.code !== 131047) throw error;
      id = await sendWhatsAppTemplate(admin, template, [await clinicName()]);
    }
  }
  await trackHumanChatReply(id, patient);
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

  if (await handleReminderPreference(from, content, optionId, inboundAt)) return;
  if (await handleWaitlistOffer(from, optionId)) return;

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
    const sessionId = await openHumanChat(from);
    if (!sessionId) return;
    const session = { ...patient, human_session_id: sessionId };
    const notified = await notifyDoctor(session, 'Solicitó hablar con el equipo.').catch(async error => {
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
  if (await handlePatientNameCorrection(from, optionId, content)) return;
  const balancePage = optionId?.match(/^my_debts_(\d{1,5})$/);
  if (optionId === 'my_debts' || balancePage || (!optionId && /^(?:mis deudas|mi saldo)$/.test(text))) {
    return showPatientBalance(from, Number(balancePage?.[1] || 0));
  }
  const treatmentOption = optionId?.match(/^book_trt_(\d{1,9})$/);
  if (treatmentOption) {
    const treatment = await getSchedulableTreatment(Number(treatmentOption[1]));
    if (treatment) await startBooking(from, false, fullName, treatment.name, undefined, treatment.id);
    else await reply('El tratamiento salió del catálogo. Puedes elegir otro o agendar una valoración.');
    return;
  }
  if (optionId === 'agendar' || (!optionId && /^(?:(?:quiero|deseo|necesito) )?(?:agendar|reservar|hacer|sacar) (?:una )?cita$/.test(text))) {
    return startBooking(from, false, fullName);
  }
  if (await handlePatientAppointments(from, content, optionId, message.contextMessageId)) return;
  const menuNavigation = !optionId && (menuRequests.has(text) ||
    ['tratamientos', 'tratamientos y precios', 'tratamientos/precios', 'preguntas frecuentes', 'info y politicas'].includes(text));
  if (!menuNavigation && await handleBooking(from, optionId, content)) return;
  if (!optionId && /^(?:(?:si,?\s+)?confirmo|cambiar horario)$/.test(text)) return void await showPatientAppointments(from);
  if (!fullName) {
    if (optionId) return;
    const name = !inserted || /^(?:soy|me llamo|mi nombre es)\s/.test(text) ? parseName(content) : null;
    if (!name) {
      await reply(inserted ? `Hola, soy *${await botName()}*, de *${await clinicName()}*. ¿Cómo te llamas?` : '¿Cómo te llamas?');
      return;
    }
    let update = db.from('patients').update({ full_name: name, onboarding_completed: true }).eq('phone', from);
    update = patient.full_name === null ? update.is('full_name', null) : update.eq('full_name', patient.full_name);
    const { data } = await update.select('full_name').maybeSingle().throwOnError();
    if (data) await showPatientMenu(from);
    return;
  }
  if (await handleAppointmentAction(from, optionId, false)) return;
  if (optionId === 'menu_principal' || (!optionId && menuRequests.has(text))) return showPatientMenu(from, text === 'hola' ? fullName : undefined);
  if (optionId === 'menu_tratamientos' || ['tratamientos', 'tratamientos y precios', 'tratamientos/precios'].includes(text)) return showCatalog(from, 'treatments');
  if (optionId === 'menu_faqs' || ['preguntas frecuentes', 'info y politicas'].includes(text)) return showCatalog(from, 'faqs');
  const catalogOption = optionId?.match(/^(trt|faq)_(page_)?(\d{1,9})$/);
  if (catalogOption) {
    const catalog = catalogOption[1] === 'trt' ? 'treatments' : 'faqs';
    const id = Number(catalogOption[3]);
    if (catalogOption[2]) await showCatalog(from, catalog, id);
    else {
      const detail = await catalogDetail(catalog, id) || 'Esta opción ya no está disponible.';
      await sendCatalogDetail(from, catalog, id, detail);
      await history(from, 'assistant', detail);
    }
    return;
  }
  if (optionId) return;
  await history(from, 'user', content);
  await runPatientAgent(from, fullName, content, reply);
}

async function finishHumanChat(admin: string, patient: HumanPatient & { last_inbound_at: string | null }) {
  if (!await closeHumanChat(patient)) return sendWhatsAppText(admin, 'Esa conversación ya está cerrada.');
  await sendWhatsAppText(admin, 'Conversación cerrada.');
  if (hasWhatsAppWindow(patient.last_inbound_at)) await sendWhatsAppText(patient.phone, `El equipo cerró la conversación. Soy ${await botName()} y vuelvo a atenderte.`)
    .catch(error => { if (!(error instanceof WhatsAppError) || error.code !== 131047) throw error; });
}

const adminPrompts: Record<string, string> = {
  admin_task: 'Escribe lo que hay que hacer. Si quieres un aviso, incluye el día y la hora. Por ejemplo, «Anota pedir guantes y recuérdamelo mañana a las 9:00».',
  admin_cerrar_chat: 'Responde al mensaje del paciente con «cerrar» para terminar su chat.',
  adm_add_treatment: 'Dime el nombre, el precio en MXN y una descripción breve del tratamiento.',
};

export async function handleAdminMessage(message: IncomingMessage) {
  const { from, content, optionId, contextMessageId } = message;
  const text = normalized(content);
  const inboundAt = inboundTime(message.timestamp);
  await db.from('bot_settings').update({ admin_last_inbound_at: inboundAt }).eq('id', 1)
    .or(`admin_last_inbound_at.is.null,admin_last_inbound_at.lt.${inboundAt}`).throwOnError();
  const close = optionId?.match(/^chat_close_([1-9]\d{7,14})_([a-f0-9-]{36})$/);
  if (close) {
    const { data: patient } = await db.from('patients').select('phone,full_name,chat_mode,human_session_id,last_inbound_at')
      .eq('phone', close[1]).eq('human_session_id', close[2]).maybeSingle().throwOnError();
    if (!patient) return void await sendWhatsAppText(from, 'Esa conversación ya está cerrada.');
    return void await finishHumanChat(from, patient);
  }
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
      if (closeRequests.has(text)) {
        return void await finishHumanChat(from, patient);
      }
      try {
        if (!hasWhatsAppWindow(patient.last_inbound_at)) throw new WhatsAppError(400, 131047);
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
  if (contextMessageId && !optionId && await handleCancellationContactReply(from, contextMessageId, content)) return;
  if (await handleAppointmentAction(from, optionId, true)) return;
  if (await handleAdminAppointments(from, optionId, contextMessageId ? '' : text)) return;
  if (await handleTreatmentEditor(from, optionId, content, contextMessageId)) return;
  if (optionId === 'admin_panel') return showAdminMenu(from);
  if (optionId === 'adm_treatment_menu') return showAdminTreatmentMenu(from);
  if (optionId === 'adm_faq_menu') return showAdminFaqMenu(from);
  if (await handleAdminWaitlist(from, optionId, contextMessageId ? '' : text)) return;
  if (await handleClinicAdministration(from, optionId, content, contextMessageId)) return;
  const taskPage = optionId?.match(/^admin_tasks_(\d{1,6})$/);
  if (taskPage || (!optionId && /^(?:ver |lista de |mis )?pendientes$/.test(text))) {
    return showPendingTasks(from, Number(taskPage?.[1] || 0));
  }
  if (!optionId) {
    const byPhone = content.trim().match(/^buscar citas? por whatsapp(?:\s+(.+))?$/i);
    if (byPhone) return showAppointmentsByWhatsApp(from, byPhone[1] || '');
    const detail = text.match(/^(?:ver )?pendiente\s+#?(\d{1,10})$/);
    if (detail) return void await showClinicTask(from, Number(detail[1]));
    const completed = text.match(/^(?:completar|completa) (?:pendiente\s+)?#?(\d{1,10})$/);
    if (completed) return void await sendWhatsAppText(from, await completeClinicTask(Number(completed[1])));
  }
  if (optionId === 'admin_booking' || (!optionId && ['crear cita', 'agendar cita', 'reservar cita'].includes(text))) {
    return startBooking(from, true);
  }
  if (!optionId && menuRequests.has(text)) {
    await notifyAdminWaitlist().catch(() => console.error('Could not notify reception about the waitlist'));
    return showAdminMenu(from);
  }
  if (optionId === 'admin_agenda' || text === 'agenda de hoy') return showSchedule(from);
  if (optionId === 'rec_tomorrow' || (!optionId && text === 'agenda de manana')) return showSchedule(from, nextDate(clinicDate()));
  if (await handleReceptionAction(from, optionId)) return;
  if (optionId && Object.hasOwn(adminPrompts, optionId)) {
    await sendWhatsAppText(from, adminPrompts[optionId]);
    return;
  }
  if (await handleBooking(from, optionId, content)) return;
  if (optionId) return;
  if (contextMessageId) return void await sendWhatsAppText(from, 'Esa respuesta no corresponde a un formulario activo. Abre «Ayuda» y vuelve a elegir la opción.');
  await runAdminAgent(from, content);
}
