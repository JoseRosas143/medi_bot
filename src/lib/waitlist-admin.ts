import { supabaseAdmin as db } from '@/lib/supabase';
import { CLINIC_TIMEZONE } from '@/lib/clinic-time';
import { showList } from '@/lib/menus';
import { waitlistOfferHistory, type WaitlistOfferStatus } from '@/lib/waitlist-offer-log';
import { sendWhatsAppText, shorten, type WhatsAppListRow } from '@/lib/whatsapp';

type Contact = { phone: string; patients: { full_name: string | null } | null };
type Request = Contact & { id: string; requested_at: string; original_start: string };
type Offer = { start_at: string; deadline: string | null; status: WaitlistOfferStatus };
type Mode = 'queue' | 'offers';

const pageSize = 5;
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
  if (mode === 'queue') {
    const { data } = await db.from('appointment_waitlist')
      .select('id,phone,requested_at,original_start,patients(full_name)')
      .gt('original_start', new Date().toISOString()).order('requested_at').order('id')
      .range(offset, offset + pageSize).throwOnError();
    const rows = (data ?? []) as unknown as Request[];
    hasNext = rows.length > pageSize;
    lines = await Promise.all(rows.slice(0, pageSize).map(async (row, index) => {
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
  await showList(phone, detail.length > 1024 ? `*${title}*` : detail, 'Ver opciones', [{ title: 'Navegación', rows }],
    'Escribe «Lista de espera» o «Historial de ofertas» para abrir la primera página.');
}

export async function handleAdminWaitlist(phone: string, option?: string, text = '') {
  const page = option?.match(/^admin_wait_(queue|offers)_(\d{1,5})$/);
  if (page) await showAdminWaitlist(phone, page[1] as Mode, Number(page[2]));
  else if (!option && text === 'lista de espera') await showAdminWaitlist(phone, 'queue', 0);
  else if (!option && text === 'historial de ofertas') await showAdminWaitlist(phone, 'offers', 0);
  else return false;
  return true;
}
