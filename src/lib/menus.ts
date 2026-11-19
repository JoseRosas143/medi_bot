import { supabaseAdmin as db } from '@/lib/supabase';
import { clinicName } from '@/lib/clinic-time';
import { sendWhatsAppInteractiveList, sendWhatsAppText, WhatsAppError, type WhatsAppListSection } from '@/lib/whatsapp';

export const botName = () => process.env.CLINIC_BOT_NAME || 'Benson';

export function normalized(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[.!?]+$/, '');
}

export function formatPrice(price: number | string) {
  const amount = Number(price);
  return price !== null && Number.isFinite(amount)
    ? new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', currencyDisplay: 'code' }).format(amount)
    : 'Consulta el precio con recepción';
}

async function showList(to: string, bodyText: string, buttonText: string, sections: WhatsAppListSection[]) {
  try {
    await sendWhatsAppInteractiveList({ to, bodyText, buttonText, sections });
  } catch (error) {
    if (!(error instanceof WhatsAppError) || ![100, 131009, 131051].includes(error.code ?? 0)) throw error;
    const sectionsText = sections.map(section =>
      `*${section.title}*\n${section.rows.map(row => `• ${row.title}${row.description ? ` — ${row.description}` : ''}`).join('\n')}`,
    ).join('\n\n');
    await sendWhatsAppText(to, `${bodyText}\n\n${sectionsText}\n\nEscribe el nombre de la opción que te interesa.`);
  }
}

export function showPatientMenu(to: string, firstName?: string) {
  const intro = firstName ? `Hola, ${firstName}. Soy ${botName()}, de ${clinicName()}.` : `Soy ${botName()}, de ${clinicName()}.`;
  return showList(to, `🦷 *${clinicName()}*\n${intro}\n\nElige una opción o escríbeme lo que necesitas.`, 'Ver opciones', [
    { title: 'Tu cita', rows: [
      { id: 'agendar', title: 'Agendar cita', description: 'Consulta horarios y reserva' },
      { id: 'cancelar', title: 'Mis citas', description: 'Consulta o cancela una cita' },
      { id: 'urgencia', title: 'Atención prioritaria', description: 'Solicita apoyo de la clínica' },
    ] },
    { title: 'La clínica', rows: [
      { id: 'menu_tratamientos', title: 'Tratamientos y precios', description: 'Explora los precios registrados' },
      { id: 'menu_faqs', title: 'Preguntas frecuentes', description: 'Consulta información de la clínica' },
      { id: 'doctor', title: 'Hablar con el doctor', description: 'Pide atención por este chat' },
    ] },
  ]);
}

export function showAdminMenu(to: string) {
  return showList(to, `🦷 *${clinicName()} · Administración*\nElige una tarea o escribe lo que necesitas hacer.`, 'Abrir panel', [
    { title: 'Agenda y clínica', rows: [
      { id: 'admin_agenda', title: 'Agenda de hoy' },
      { id: 'admin_cancelar', title: 'Cancelar cita' },
      { id: 'admin_task', title: 'Anotar pendiente' },
      { id: 'admin_cerrar_chat', title: 'Cerrar chat directo' },
    ] },
    { title: 'Catálogo', rows: [
      { id: 'adm_add_treatment', title: 'Agregar tratamiento' },
      { id: 'adm_edit_treatment', title: 'Editar tratamiento', description: 'Actualiza el precio o retíralo del menú' },
      { id: 'adm_add_faq', title: 'Agregar pregunta' },
      { id: 'adm_edit_faq', title: 'Editar pregunta', description: 'Actualiza la respuesta o retira la pregunta' },
    ] },
  ]);
}

export type Catalog = 'treatments' | 'faqs';
const catalogId = { treatments: 'trt', faqs: 'faq' };
const pageSize = 7;

export async function showCatalog(to: string, catalog: Catalog, page = 0) {
  const isTreatment = catalog === 'treatments';
  const prefix = catalogId[catalog];
  const title = isTreatment ? 'Tratamientos y precios' : 'Preguntas frecuentes';
  const start = page * pageSize;
  const result = await db.from(catalog).select('*').eq('is_active', true).order('id').range(start, start + pageSize).throwOnError();
  const data = result.data ?? [];
  const navigation = [];
  if (page > 0) navigation.push({ id: `${prefix}_page_${page - 1}`, title: 'Página anterior' });
  if (data.length > pageSize) navigation.push({ id: `${prefix}_page_${page + 1}`, title: 'Página siguiente' });
  navigation.push({ id: 'menu_principal', title: 'Menú principal' });
  const rows = data.slice(0, pageSize).map(item => ({
    id: `${prefix}_${item.id}`,
    title: isTreatment ? item.name : item.question,
    description: isTreatment ? formatPrice(item.price) : item.question.length > 24 ? item.question : undefined,
  }));
  const sections: WhatsAppListSection[] = rows.length ? [{ title, rows }] : [];
  sections.push({ title: 'Navegación', rows: navigation });
  await showList(to, `*${title}*\n${rows.length ? 'Elige una opción para ver el detalle.' : 'Aún no hay opciones en esta página.'}`, 'Ver opciones', sections);
}

export async function catalogDetail(catalog: Catalog, id: number): Promise<string | null> {
  const { data } = await db.from(catalog).select('*').eq('id', id).eq('is_active', true).maybeSingle().throwOnError();
  if (!data) return null;
  return catalog === 'treatments'
    ? `🦷 *${data.name}*\nPrecio registrado: ${formatPrice(data.price)}.\n\nPara reservar, escribe «agendar cita».`
    : `ℹ️ *${data.question}*\n${data.answer}`;
}

export async function findCatalogEntries(catalog: Catalog, term: string) {
  const clean = term.replace(/[%*_\\]/g, '').trim().slice(0, 120);
  if (clean.length < 2) return [];
  const field = catalog === 'treatments' ? 'name' : 'question';
  const { data } = await db.from(catalog).select(`id,${field}`).eq('is_active', true)
    .ilike(field, `%${clean}%`).order('id').limit(6).throwOnError();
  const entries = (data ?? []).map(item => ({ id: item.id as number, label: (item as unknown as Record<string, string>)[field] }));
  const exact = entries.filter(item => normalized(item.label) === normalized(clean));
  return exact.length ? exact : entries;
}
