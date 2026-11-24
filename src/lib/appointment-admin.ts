import { createHash } from 'node:crypto';
import { proposeAppointmentAction } from '@/lib/appointment-actions';
import { appointmentPatientName, getAppointmentsByDateRange, type CalendarEventData } from '@/lib/calendar';
import { CLINIC_TIMEZONE } from '@/lib/clinic-time';
import { showList } from '@/lib/menus';
import { sendWhatsAppText } from '@/lib/whatsapp';

const shortDate = new Intl.DateTimeFormat('es-MX', {
  timeZone: CLINIC_TIMEZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const code = (event: CalendarEventData) => createHash('sha256').update(JSON.stringify([
  event.eventId, event.patientPhone, event.summary, event.start, event.end,
])).digest('hex').slice(0, 32);

export async function handleAdminAppointments(admin: string, option?: string, text?: string) {
  const pageOption = option?.match(/^admin_appt_page_(\d{1,4})_(\d{1,4})$/);
  const selected = option?.match(/^admin_appt_view_(\d{1,4})_([a-f0-9]{32})$/);
  if (!pageOption && !selected && option !== 'admin_cancelar' && (option || text !== 'administrar cita')) return false;
  const period = Number(pageOption?.[1] || selected?.[1] || 0);
  const periodLength = 90 * 86_400_000;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const from = today.getTime() + period * periodLength;
  const to = from + periodLength;
  const now = Date.now();
  const events = (await getAppointmentsByDateRange(new Date(from).toISOString(), new Date(to).toISOString()))
    .filter(event => Date.parse(event.start) > now && Date.parse(event.start) >= from && Date.parse(event.start) < to)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (selected) {
    const event = events.find(item => code(item) === selected[2]);
    if (event) await proposeAppointmentAction(admin, { action: 'cancel_clinic', details: event }, true);
    else await sendWhatsAppText(admin, 'Esa cita cambió. Abre «Administrar cita» para ver los horarios vigentes.');
    return true;
  }
  const size = 7;
  const page = Number(pageOption?.[2] || 0);
  const more = events.length > (page + 1) * size;
  const rows = events.slice(page * size, (page + 1) * size).map(event => ({
    id: `admin_appt_view_${period}_${code(event)}`, title: appointmentPatientName(event.summary),
    description: `${shortDate.format(new Date(event.start))}${event.patientPhone ? ` · •••• ${event.patientPhone.slice(-4)}` : ''}`,
  }));
  await showList(admin, `*Administrar cita*\n${rows.length ? 'Elige una cita para ver las acciones disponibles.' : 'No encontré citas futuras en esta página.'}`,
    'Ver citas', [
      ...(rows.length ? [{ title: 'Próximas citas', rows }] : []),
      { title: 'Navegación', rows: [
        ...(page ? [{ id: `admin_appt_page_${period}_${page - 1}`, title: 'Página anterior' }]
          : period ? [{ id: `admin_appt_page_${period - 1}_0`, title: 'Periodo anterior' }] : []),
        ...(more ? [{ id: `admin_appt_page_${period}_${page + 1}`, title: 'Página siguiente' }]
          : period < 9999 ? [{ id: `admin_appt_page_${period + 1}_0`, title: 'Ver siguientes 90 días' }] : []),
        { id: 'admin_panel', title: 'Volver al panel' },
      ] },
    ]);
  return true;
}
