import { supabaseAdmin as db } from '@/lib/supabase';
import { clinicDayRange, clinicInstant, formatAppointment } from '@/lib/clinic-time';
import { showList } from '@/lib/menus';
import { sendWhatsAppInteractiveButtons, sendWhatsAppText, type WhatsAppListRow } from '@/lib/whatsapp';

export type BlockAction = 'block_dates' | 'block_hours';
export type Interval = { starts_at: string; ends_at: string };
const datePattern = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4})';
const dates = new RegExp(`^(${datePattern})(?:\\s+a\\s+(${datePattern}))?$`, 'i');
const hours = new RegExp(`^(${datePattern})\\s+(\\d{2}:\\d{2})\\s*[-–]\\s*(\\d{2}:\\d{2})$`);
export const scheduleBlocks = () => db.from('clinic_schedule_blocks');

function dateKey(value: string) {
  const [day, month, year] = value.split('/');
  const iso = year ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : value;
  const date = new Date(`${iso}T00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error('Fecha inválida');
  return iso;
}

export function parseScheduleBlock(value: string, action: BlockAction): Interval | null {
  try {
    const match = (action === 'block_dates' ? dates : hours).exec(value.trim());
    if (!match) return null;
    const date = dateKey(match[1]);
    const lastDate = action === 'block_dates' && match[2] ? dateKey(match[2]) : date;
    if (lastDate < date) return null;
    if (action === 'block_hours' && ![match[2], match[3]].every(hour => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hour))) return null;
    const starts_at = action === 'block_dates' ? clinicDayRange(date)[0] : clinicInstant(date, match[2]).toISOString();
    const ends_at = action === 'block_dates' ? clinicDayRange(lastDate)[1] : clinicInstant(date, match[3]).toISOString();
    return Date.parse(ends_at) > Math.max(Date.parse(starts_at), Date.now()) ? { starts_at, ends_at } : null;
  } catch {
    return null;
  }
}

export async function getScheduleBlocks(start: string, end: string) {
  const { data } = await scheduleBlocks().select('starts_at,ends_at').lt('starts_at', end).gt('ends_at', start).throwOnError();
  return (data ?? []) as Interval[];
}

export function describeBlock(block: Interval) {
  return `Desde ${formatAppointment(block.starts_at)}\nHasta ${formatAppointment(block.ends_at)}`;
}

export async function showScheduleBlocks(admin: string, page = 0) {
  const size = 5;
  const offset = page * size;
  const { data } = await scheduleBlocks().select('id,starts_at,ends_at')
    .gt('ends_at', new Date().toISOString()).order('starts_at').order('id').range(offset, offset + size).throwOnError();
  const rows: WhatsAppListRow[] = [
    { id: 'setup_block_dates', title: 'Bloquear fechas' },
    { id: 'setup_block_hours', title: 'Bloquear horas' },
    ...(page > 0 ? [{ id: `setup_blocks_${page - 1}`, title: 'Página anterior' }] : []),
    ...((data?.length ?? 0) > size ? [{ id: `setup_blocks_${page + 1}`, title: 'Página siguiente' }] : []),
    { id: 'admin_config', title: 'Configuración' },
  ];
  const blocks = (data ?? []).slice(0, size).map((block, index) => ({
    id: `setup_block_review_${block.id}`, title: `Bloqueo ${offset + index + 1}`,
    description: describeBlock(block).replace('\n', ' · '),
  }));
  await showList(admin, `*Bloqueos de agenda*\n${blocks.length ? 'Selecciona un bloqueo para revisarlo o crea uno.' : 'No hay bloqueos en esta página.'}`,
    'Ver opciones', [{ title: 'Acciones', rows }, ...(blocks.length ? [{ title: 'Bloqueos', rows: blocks }] : [])]);
}

export async function reviewScheduleBlock(admin: string, id: string) {
  const { data } = await scheduleBlocks().select('starts_at,ends_at').eq('id', id).maybeSingle().throwOnError();
  if (!data) return sendWhatsAppText(admin, 'Ese bloqueo ya no está activo.');
  await sendWhatsAppInteractiveButtons({ to: admin, bodyText: `*Quitar bloqueo*\n${describeBlock(data)}`, buttons: [
    { id: `setup_block_remove_${id}`, title: 'Quitar bloqueo' }, { id: 'setup_blocks_0', title: 'Volver' },
  ] });
}

export async function removeScheduleBlock(admin: string, id: string) {
  const { data } = await scheduleBlocks().delete().eq('id', id).select('id').maybeSingle().throwOnError();
  await sendWhatsAppText(admin, data ? 'Bloqueo retirado. Benson volverá a comprobar la disponibilidad de Calendar.' : 'Ese bloqueo ya fue retirado.');
}
