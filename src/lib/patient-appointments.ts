import { createHash } from 'node:crypto';
import { proposeAppointmentAction } from '@/lib/appointment-actions';
import { startReschedule } from '@/lib/booking';
import { confirmCalendarAttendance, getPatientAppointments, type CalendarEventData } from '@/lib/calendar';
import { CLINIC_TIMEZONE, formatAppointment } from '@/lib/clinic-time';
import { formatVisitLocation } from '@/lib/clinic-visit';
import { normalized } from '@/lib/menus';
import { supabaseAdmin as db } from '@/lib/supabase';
import { changeWaitlistEnrollment, showWaitlistRequest } from '@/lib/waitlist';
import { sendWhatsAppInteractiveButtons, sendWhatsAppInteractiveList, sendWhatsAppText, shorten } from '@/lib/whatsapp';

const pageSize = 8;
const shortDate = new Intl.DateTimeFormat('es-MX', {
  timeZone: CLINIC_TIMEZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function appointmentCode(event: CalendarEventData) {
  return createHash('sha256').update(JSON.stringify([event.eventId, Date.parse(event.start)])).digest('hex').slice(0, 32);
}

function showAppointment(phone: string, event: CalendarEventData) {
  const id = appointmentCode(event);
  const bodyText = `🗓️ *Tu cita*\n${formatAppointment(event.start)}\n\n${event.attendanceConfirmed ? 'Asistencia confirmada' : 'Asistencia pendiente de confirmar'}\n\n${formatVisitLocation()}`;
  const buttons = [
      ...(!event.attendanceConfirmed ? [{ id: `appt_attend_${id}`, title: 'Confirmar asistencia' }] : []),
      { id: `appt_move_${id}`, title: 'Cambiar horario' },
      { id: `appt_wait_${id}`, title: 'Lista de espera' },
      { id: `appt_cancel_${id}`, title: 'Cancelar cita' },
  ];
  return buttons.length <= 3
    ? sendWhatsAppInteractiveButtons({ to: phone, bodyText, buttons })
    : sendWhatsAppInteractiveList({ to: phone, bodyText, buttonText: 'Ver opciones', sections: [{ title: 'Tu cita', rows: buttons }] });
}

export async function showPatientAppointments(phone: string, page = 0) {
  const events = await getPatientAppointments(phone);
  if (!events.length) return sendWhatsAppText(phone, 'No encontré citas futuras asociadas a tu WhatsApp.');
  if (events.length === 1) return showAppointment(phone, events[0]);
  const offset = page * pageSize;
  const rows = events.slice(offset, offset + pageSize).map(event => ({
    id: `appt_view_${appointmentCode(event)}`,
    title: shorten(shortDate.format(new Date(event.start)), 24),
    description: event.attendanceConfirmed ? 'Asistencia confirmada' : 'Asistencia pendiente de confirmar',
  }));
  if (!rows.length) return sendWhatsAppText(phone, 'Esta página ya no tiene citas. Escribe «Mis citas» para actualizar la lista.');
  return sendWhatsAppInteractiveList({
    to: phone,
    bodyText: '🗓️ *Mis citas*\nSelecciona una cita para confirmar asistencia, cambiar el horario o cancelar.',
    buttonText: 'Ver mis citas',
    sections: [
      { title: 'Próximas citas', rows },
      ...(page > 0 || offset + pageSize < events.length ? [{
        title: 'Navegación',
        rows: [
          ...(page > 0 ? [{ id: `appt_page_${page - 1}`, title: 'Anterior' }] : []),
          ...(offset + pageSize < events.length ? [{ id: `appt_page_${page + 1}`, title: 'Siguiente' }] : []),
        ],
      }] : []),
    ],
  });
}

type Action = 'view' | 'attend' | 'move' | 'cancel';

async function actOnAppointment(phone: string, event: CalendarEventData, action: Action, text?: string) {
  if (action === 'move') return startReschedule(phone, event, text);
  if (action === 'cancel') return proposeAppointmentAction(phone, { action: 'cancel_patient', details: event });
  if (action === 'view') return showAppointment(phone, event);

  const result = await confirmCalendarAttendance(event, phone);
  if (result.state === 'confirmed') return sendWhatsAppText(phone, `✅ Asistencia confirmada para ${result.label}.`);
  return sendWhatsAppText(phone, 'Ese horario cambió o ya pasó. Abre «Mis citas» para ver tu agenda actual.');
}

export async function handlePatientAppointments(phone: string, content: string, option?: string, contextId?: string) {
  const text = normalized(content).replace(/^[¡¿]+/, '');
  const page = option?.match(/^appt_page_(\d{1,5})$/);
  if (page || option === 'cancelar' || (!option && /^(?:mis citas|lista de espera|adelantar (?:mi|la) cita)$/.test(text))) {
    await showPatientAppointments(phone, Number(page?.[1] || 0));
    return true;
  }

  const button = option?.match(/^appt_(view|attend|move|cancel|wait|wait_join|wait_leave)_([\da-f]{32})$/);
  if (button) {
    const event = (await getPatientAppointments(phone)).find(item => appointmentCode(item) === button[2]);
    if (!event) await sendWhatsAppText(phone, 'Ese horario cambió o ya pasó. Abre «Mis citas» para ver tu agenda actual.');
    else if (button[1] === 'wait') await showWaitlistRequest(phone, event, button[2]);
    else if (button[1] === 'wait_join' || button[1] === 'wait_leave') await changeWaitlistEnrollment(phone, event, button[1] === 'wait_join');
    else await actOnAppointment(phone, event, button[1] as Action);
    return true;
  }
  if (option) return false;

  const attend = /^(?:(?:si,?\s+)?confirmo(?:\s+(?:mi )?asistencia)?|confirmar asistencia|si asistire)$/;
  const move = /^(?:(?:quiero|necesito|deseo)\s+)?(?:reagendar|reprogramar|cambiar (?:el )?horario|cambiar (?:mi|la) cita)(?:\s|$)/;
  const cancel = /^(?:(?:quiero|necesito)\s+)?cancelar(?:\s+(?:mi|la) cita)?$/;
  const action = attend.test(text) ? 'attend' : move.test(text) ? 'move' : cancel.test(text) ? 'cancel' : null;
  if (!action) return false;

  if (contextId) {
    const { data } = await db.from('appointment_notices').select('event_id,scheduled_start')
      .eq('wa_message_id', contextId).eq('kind', 'reminder').maybeSingle().throwOnError();
    if (data) {
      const event = (await getPatientAppointments(phone)).find(item => item.eventId === data.event_id &&
        Date.parse(item.start) === Date.parse(data.scheduled_start));
      if (event) await actOnAppointment(phone, event, action, content);
      else await sendWhatsAppText(phone, 'Ese recordatorio corresponde a un horario que cambió o ya pasó. Abre «Mis citas».');
      return true;
    }
  }
  if (/^(?:si,?\s+)?confirmo$/.test(text) || text === 'cambiar horario') return false;
  await showPatientAppointments(phone);
  return true;
}
