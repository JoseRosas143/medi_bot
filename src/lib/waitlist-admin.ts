import { supabaseAdmin as db } from '@/lib/supabase';
import { CLINIC_TIMEZONE } from '@/lib/clinic-time';
import { showList } from '@/lib/menus';
import { waitlistOfferHistory, type WaitlistOfferStatus } from '@/lib/waitlist-offer-log';
import { withdrawWaitlistRequest } from '@/lib/waitlist';
import { sendWhatsAppInteractiveButtons, sendWhatsAppText, shorten, type WhatsAppListRow } from '@/lib/whatsapp';

type Contact = { phone: string; patients: { full_name: string | null } | null };
type Request = Contact & { id: string; requested_at: string; original_start: string };
type Offer = { start_at: string; deadline: string | null; status: WaitlistOfferStatus };
type Mode = 'queue' | 'offers';

const pageSize = 5;
const requestColumns = 'id,phone,requested_at,original_start,patients(full_name)';
const timestamp = new Intl.DateTimeFormat('es-MX', {
  timeZone: CLINIC_TIMEZONE, day: 'numeric', month: 'short', year: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const when = (value: string) => timestamp.format(new Date(value));
const name = (contact: Contact) => `${shorten(contact.patients?.full_name || 'Paciente', 60)} · •••• ${contact.phone.slice(-4)}`;
const statusLabels: Record<WaitlistOfferStatus, string> = {
  sending: 'Envío en curso', sent: 'Enviada a WhatsApp', unknown: 'Envío sin confirmar', send_error: 'Envío rechazado',
  accepted: 'Aceptada', declined: 'Rechazada por el paciente', expired: 'Vencida', withdrawn: 'Se retiró de la lista',
  unavailable: 'No se pudo adelantar la cita',
};

function describeOffer(offer: Offer) {
  const pending = ['sending', 'sent', 'unknown'].includes(offer.status);
  const valid = pending && offer.deadline && Date.parse(offer.deadline) > Date.now();
  const suffix = valid ? ` · vence ${when(offer.deadline!)}` : '';
  const label = pending && offer.deadline && !valid ? 'Vencida' : statusLabels[offer.status];
  return `${when(offer.start_at)} · ${label}${suffix}`;
}

async function showAdminWaitlist(phone: string, mode: Mode, page: number) {
  const offset = page * pageSize;
  let lines: string[];
  let hasNext: boolean;
  let entries: WhatsAppListRow[] = [];
  if (mode === 'queue') {
    const { data } = await db.from('appointment_waitlist')
      .select(requestColumns)
      .gt('original_start', new Date().toISOString()).order('requested_at').order('id')
      .range(offset, offset + pageSize).throwOnError();
    const rows = (data ?? []) as unknown as Request[];
    hasNext = rows.length > pageSize;
    const displayed = rows.slice(0, pageSize);
    entries = displayed.map((row, index) => ({
      id: `admin_wait_review_${row.id}`, title: `${offset + index + 1}. ${row.patients?.full_name || 'Paciente'}`,
      description: `•••• ${row.phone.slice(-4)} · Revisar solicitud`,
    }));
    lines = await Promise.all(displayed.map(async (row, index) => {
      const { data: offer } = await waitlistOfferHistory().select('start_at,deadline,status')
        .eq('request_id', row.id).order('created_at', { ascending: false }).order('offer_id').limit(1).maybeSingle().throwOnError();
      return `*${offset + index + 1}. ${name(row)}*\nSolicitud ${when(row.requested_at)} · Cita actual ${when(row.original_start)}\n${offer ? describeOffer(offer as Offer) : 'Sin oferta registrada'}`;
    }));
  } else {
    const { data } = await waitlistOfferHistory().select('phone,start_at,deadline,status,patients(full_name)')
      .order('created_at', { ascending: false }).order('offer_id').range(offset, offset + pageSize).throwOnError();
    const rows = (data ?? []) as unknown as (Offer & Contact)[];
    hasNext = rows.length > pageSize;
    lines = rows.slice(0, pageSize).map(offer => `*${name(offer)}*\n${describeOffer(offer)}`);
  }
  const title = mode === 'queue' ? 'Lista de espera' : 'Historial de ofertas';
  const alternate: WhatsAppListRow = mode === 'queue'
    ? { id: 'admin_wait_offers_0', title: 'Historial de ofertas' }
    : { id: 'admin_wait_queue_0', title: 'Lista de espera' };
  const rows = [
    alternate,
    ...(page > 0 ? [{ id: `admin_wait_${mode}_${page - 1}`, title: 'Página anterior' }] : []),
    ...(hasNext ? [{ id: `admin_wait_${mode}_${page + 1}`, title: 'Página siguiente' }] : []),
    { id: 'admin_agenda', title: 'Agenda de hoy' },
  ];
  const body = lines.length ? lines.join('\n\n') : page > 0 ? 'Esta página ya no tiene resultados.'
    : mode === 'queue' ? 'No hay solicitudes activas.' : 'Aún no hay ofertas registradas.';
  const detail = `*${title}*\n\n${body}`;
  if (detail.length > 1024) await sendWhatsAppText(phone, detail);
  await showList(phone, detail.length > 1024 ? `*${title}*` : detail, 'Ver opciones', [
    ...(entries.length ? [{ title: 'Gestionar solicitud', rows: entries }] : []),
    { title: 'Navegación', rows },
  ],
    'Escribe «Lista de espera» o «Historial de ofertas» para abrir la primera página.');
}

async function reviewWithdrawal(phone: string, id: string) {
  const { data } = await db.from('appointment_waitlist').select(requestColumns).eq('id', id)
    .gt('original_start', new Date().toISOString()).maybeSingle().throwOnError();
  if (!data) return sendWhatsAppText(phone, 'Esa solicitud ya no está activa. Actualiza la lista de espera.');
  const request = data as unknown as Request;
  return sendWhatsAppInteractiveButtons({
    to: phone,
    bodyText: `*Retirar de la lista de espera*\n${name(request)}\nCita actual ${when(request.original_start)}\n\nSe conserva su cita. Si tiene una oferta vigente, el hueco pasa al siguiente paciente elegible.`,
    buttons: [
      { id: `admin_wait_remove_${request.id}`, title: 'Sí, retirar' },
      { id: 'admin_wait_queue_0', title: 'Volver a la lista' },
    ],
  });
}

async function confirmWithdrawal(phone: string, id: string) {
  const result = await withdrawWaitlistRequest(id);
  const message = result.state === 'removed'
    ? `✅ Solicitud retirada de la lista de espera. La cita conserva su horario.${result.releasedOffer ? '\nBenson liberó el hueco para el siguiente turno.' : ''}`
    : result.state === 'missing' ? 'Esa solicitud ya no está activa.'
    : 'La agenda está verificando una operación. Vuelve a intentar el retiro en un momento.';
  await sendWhatsAppInteractiveButtons({
    to: phone, bodyText: message,
    buttons: [
      ...(result.state === 'busy' || result.state === 'processing' ? [{ id: `admin_wait_remove_${id}`, title: 'Reintentar retiro' }] : []),
      { id: 'admin_wait_queue_0', title: 'Volver a la lista' },
    ],
  });
}

export async function handleAdminWaitlist(phone: string, option?: string, text = '') {
  const page = option?.match(/^admin_wait_(queue|offers)_(\d{1,5})$/);
  const removal = option?.match(/^admin_wait_(review|remove)_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
  if (page) await showAdminWaitlist(phone, page[1] as Mode, Number(page[2]));
  else if (removal?.[1] === 'review') await reviewWithdrawal(phone, removal[2]);
  else if (removal?.[1] === 'remove') await confirmWithdrawal(phone, removal[2]);
  else if (!option && text === 'lista de espera') await showAdminWaitlist(phone, 'queue', 0);
  else if (!option && text === 'historial de ofertas') await showAdminWaitlist(phone, 'offers', 0);
  else return false;
  return true;
}
