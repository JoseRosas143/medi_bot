import { createHash } from 'node:crypto';
import { getAppointmentsByDateRange, recordCalendarVisit, type CalendarEventData, type VisitStatus } from '@/lib/calendar';
import { clinicDate, clinicDayRange, formatAppointment } from '@/lib/clinic-time';
import { sendWhatsAppInteractiveButtons, sendWhatsAppInteractiveList, sendWhatsAppText, shorten } from '@/lib/whatsapp';

export function visitStatusLabel(status: VisitStatus) {
  return status === 'arrived' ? 'Llegó' : 'No asistió';
}

function appointmentToken(event: CalendarEventData) {
  return createHash('sha256').update(JSON.stringify([
    event.eventId, Date.parse(event.start), Date.parse(event.end), event.summary, event.patientPhone, event.visitStatus,
  ])).digest('hex').slice(0, 32);
}

async function todaysVisits() {
  const appointments = await getAppointmentsByDateRange(...clinicDayRange(clinicDate()));
  return appointments.filter(event => Boolean(event.patientPhone) || /^(?:\[URGENTE\]\s*)?Cita:/i.test(event.summary));
}

async function showVisits(phone: string, visits: CalendarEventData[], page: number) {
  if (!visits.length) return sendWhatsAppText(phone, 'No hay citas para registrar hoy.');
  const size = 7;
  const current = Math.min(page, Math.floor((visits.length - 1) / size));
  return sendWhatsAppInteractiveList({
    to: phone, bodyText: '*Registrar visita*\nElige la cita de hoy.', buttonText: 'Ver citas', sections: [
      { title: 'Citas de hoy', rows: visits.slice(current * size, (current + 1) * size).map(event => ({
        id: `rec_pick_${appointmentToken(event)}`, title: event.summary,
        description: `${formatAppointment(event.start)}${event.visitStatus ? ` · ${visitStatusLabel(event.visitStatus)}` : ''}`,
      })) },
      { title: 'Navegación', rows: [
        ...(current > 0 ? [{ id: `rec_visits_${current - 1}`, title: 'Página anterior' }] : []),
        ...(visits.length > (current + 1) * size ? [{ id: `rec_visits_${current + 1}`, title: 'Página siguiente' }] : []),
        { id: 'admin_agenda', title: 'Volver a agenda' },
      ] },
    ],
  });
}

export async function handleReceptionAction(phone: string, option: string | undefined) {
  const page = option?.match(/^rec_visits_(\d{1,5})$/);
  const choice = option?.match(/^rec_(pick|arrived|no_show)_([a-f0-9]{32})$/);
  if (!page && !choice) return false;
  const visits = await todaysVisits();
  if (page) {
    await showVisits(phone, visits, Number(page[1]));
    return true;
  }

  const [, action, token] = choice!;
  const event = visits.find(visit => appointmentToken(visit) === token);
  if (!event) {
    await sendWhatsAppText(phone, 'La cita o su estado cambió. Abre la agenda de hoy para consultar el registro actual.');
    return true;
  }
  if (action === 'pick') {
    const statuses: VisitStatus[] = Date.parse(event.start) > Date.now() ? ['arrived'] : ['arrived', 'no_show'];
    await sendWhatsAppInteractiveButtons({
      to: phone, bodyText: `*Registrar visita*\n${shorten(event.summary, 160)}\n${formatAppointment(event.start)}`,
      buttons: [
        ...statuses.map(status => ({ id: `rec_${status}_${token}`, title: visitStatusLabel(status) })),
        { id: 'rec_visits_0', title: 'Volver a citas' },
      ],
    });
    return true;
  }

  const status = action as VisitStatus;
  const result = await recordCalendarVisit(event, status);
  await sendWhatsAppText(phone, result === 'saved'
    ? `✅ ${visitStatusLabel(status)} · ${event.summary}\n${formatAppointment(event.start)}`
    : result === 'too_early' ? 'Aún no llega la hora de la cita. Puedes registrar la inasistencia después de que empiece.'
    : 'La cita cambió. Consulta la agenda de hoy antes de actualizar su estado.');
  return true;
}
