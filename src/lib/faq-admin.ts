import { showList } from '@/lib/menus';
import { supabaseAdmin as db } from '@/lib/supabase';
import { sendWhatsAppText } from '@/lib/whatsapp';

export type FaqAction = 'faq_add' | 'faq_question' | 'faq_answer' | 'faq_hide';
type Faq = { id: number; question: string; answer: string; is_active: boolean };
export const isFaqAction = (action: string): action is FaqAction => ['faq_add', 'faq_question', 'faq_answer', 'faq_hide'].includes(action);
const back = { id: 'adm_faq_menu', title: 'Volver a preguntas' };
const missing = 'La pregunta cambió o ya fue retirada. Abre el listado para ver las preguntas vigentes.';
const fields = 'id,question,answer,is_active';

export async function showFaqs(admin: string, page = 0) {
  const size = 7;
  const { data } = await db.from('faqs').select(fields).eq('is_active', true).order('id')
    .range(page * size, (page + 1) * size).throwOnError();
  const faqs = (data ?? []) as Faq[];
  await showList(admin, '*Editar preguntas frecuentes*\nElige la pregunta que quieres editar o retirar.', 'Ver preguntas', [
    ...(faqs.length ? [{ title: 'Preguntas activas', rows: faqs.slice(0, size).map(faq =>
      ({ id: `faq_admin_view_${faq.id}`, title: faq.question, description: faq.question })) }] : []),
    { title: 'Navegación', rows: [
      ...(page ? [{ id: `faq_admin_page_${page - 1}`, title: 'Página anterior' }] : []),
      ...(faqs.length > size ? [{ id: `faq_admin_page_${page + 1}`, title: 'Página siguiente' }] : []),
      back,
    ] },
  ]);
}

export async function findAdminFaq(id: number): Promise<Faq | null> {
  const { data } = await db.from('faqs').select(fields).eq('id', id).eq('is_active', true).maybeSingle().throwOnError();
  return data;
}

export function showAdminFaq(admin: string, faq: Faq) {
  return showList(admin, `*${faq.question}*\n\n${faq.answer}`, 'Ver acciones', [{ title: 'Esta pregunta', rows: [
    { id: `faq_admin_question_${faq.id}`, title: 'Editar pregunta' },
    { id: `faq_admin_answer_${faq.id}`, title: 'Editar respuesta' },
    { id: `faq_admin_hide_${faq.id}`, title: 'Retirar pregunta' },
    { id: 'adm_edit_faq', title: 'Volver al listado' },
  ] }]);
}

export function faqInput(action: FaqAction, value: string): Partial<Pick<Faq, 'question' | 'answer' | 'is_active'>> | null {
  if (action === 'faq_add') {
    const parts = value.split('|').map(part => part.trim());
    return parts.length === 2 && parts[0] && parts[0].length <= 250 && parts[1] && parts[1].length <= 650
      ? { question: parts[0], answer: parts[1] } : null;
  }
  if (action === 'faq_hide') return { is_active: false };
  if (!value) return null;
  if (action === 'faq_question') return value.length <= 250 ? { question: value } : null;
  return value.length <= 650 ? { answer: value } : null;
}

export async function saveFaq(admin: string, action: FaqAction, snapshot: string, value: string) {
  const changes = faqInput(action, value);
  if (!changes) return sendWhatsAppText(admin, 'El contenido cambió. Abre el listado y vuelve a intentar.');
  const faq = snapshot ? JSON.parse(snapshot) as Faq : null;
  const result = faq ? await db.from('faqs').update(changes).eq('id', faq.id).eq('is_active', true)
    .eq('question', faq.question).eq('answer', faq.answer).select(fields).maybeSingle()
    : await db.from('faqs').insert(changes).select(fields).single();
  if (result.error?.code === '23505') return sendWhatsAppText(admin, 'Ya hay una pregunta activa con ese texto. Abre el listado para editarla.');
  if (result.error) throw result.error;
  if (!result.data) return sendWhatsAppText(admin, missing);
  if (action === 'faq_hide') return sendWhatsAppText(admin, '✅ Pregunta retirada del menú de pacientes.');
  return showAdminFaq(admin, result.data);
}
