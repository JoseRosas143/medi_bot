import { randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase';
import { formatPrice, formatTreatmentDetail, normalized, showList, type TreatmentCard } from '@/lib/menus';
import { sendWhatsAppInteractiveButtons, sendWhatsAppText, type WhatsAppListSection } from '@/lib/whatsapp';

type Treatment = TreatmentCard & { id: number; is_active: boolean };
type Field = 'description' | 'price' | 'name' | 'is_active';
type Value = string | number | boolean | null;
type Draft = {
  revision: string; treatment_id: number; field: Field; previous_value: Value;
  next_value: Value; prompt_id: string | null; expires_at: string;
};

const labels: Record<Field, string> = {
  description: 'Descripción', price: 'Precio en MXN', name: 'Nombre', is_active: 'Visibilidad',
};
const columns = 'id,name,price,description,is_active';
const expiry = () => new Date(Date.now() + 15 * 60_000).toISOString();
const drafts = () => db.from('treatment_edit_drafts');
const expired = (phone: string) => sendWhatsAppText(phone, 'La opción cambió o venció. Abre «Editar tratamiento» para retomar la ficha.');
const visibility = (active: boolean) => active ? 'Visible para pacientes' : 'Oculto';

async function getTreatment(id: number): Promise<Treatment | null> {
  const { data } = await db.from('treatments').select(columns).eq('id', id).maybeSingle().throwOnError();
  return data;
}

async function showTreatments(phone: string, page = 0) {
  const size = 7;
  const { data } = await db.from('treatments').select(columns).order('id').range(page * size, (page + 1) * size).throwOnError();
  const entries = data ?? [];
  const rows = entries.slice(0, size).map(treatment => ({
    id: `ted_card_${treatment.id}`, title: treatment.name,
    description: `#${treatment.id} · ${visibility(treatment.is_active)} · ${formatPrice(treatment.price)}`,
  }));
  const sections: WhatsAppListSection[] = rows.length ? [{ title: 'Tratamientos', rows }] : [];
  sections.push({ title: 'Navegación', rows: [
    ...(page > 0 ? [{ id: `ted_page_${page - 1}`, title: 'Página anterior' }] : []),
    ...(entries.length > size ? [{ id: `ted_page_${page + 1}`, title: 'Página siguiente' }] : []),
    { id: 'admin_panel', title: 'Panel de administración' },
  ] });
  await showList(phone, `*Editar tratamiento*\n${rows.length ? 'Selecciona una ficha para revisarla.' : 'No hay tratamientos en esta página.'}`,
    'Ver tratamientos', sections, 'Escribe «Ficha tratamiento» y el número de la ficha. Para recorrer el listado, escribe «Página tratamientos» y el número de página.');
}

async function sendChoices(phone: string, detail: string, buttons: { id: string; title: string }[]) {
  if (detail.length > 1024) await sendWhatsAppText(phone, detail);
  await sendWhatsAppInteractiveButtons({ to: phone, bodyText: detail.length > 1024 ? 'Elige una acción.' : detail, buttons });
}

async function showTreatment(phone: string, treatment: Treatment, saved = false) {
  return sendChoices(phone, `${saved ? '✅ *Cambio guardado*\n\n' : ''}${formatTreatmentDetail(treatment)}\n\n_${visibility(treatment.is_active)}_`, [
    { id: `ted_fields_${treatment.id}`, title: 'Editar datos' },
    { id: `ted_is_active_${treatment.id}`, title: treatment.is_active ? 'Ocultar ficha' : 'Mostrar ficha' },
    { id: 'adm_edit_treatment', title: 'Ver tratamientos' },
  ]);
}

function display(field: Field, value: Value) {
  if (field === 'price') return formatPrice(value as number);
  if (field === 'is_active') return visibility(value === true);
  return value === null || value === '' ? 'Sin descripción' : String(value);
}

async function showConfirmation(phone: string, name: string, draft: Draft) {
  await sendChoices(phone, `*Revisa el cambio*\n${name} · ${labels[draft.field]}\n\n*Actual*\n${display(draft.field, draft.previous_value)}\n\n*Propuesto*\n${display(draft.field, draft.next_value)}`, [
    { id: `ted_save_${draft.revision}`, title: 'Guardar cambio' },
    { id: `ted_discard_${draft.revision}`, title: 'Descartar' },
  ]);
}

async function beginEdit(phone: string, treatment: Treatment, field: Field) {
  const previous = treatment[field];
  const guidance = field === 'price' ? 'Escribe el nuevo precio en pesos, por ejemplo 850 o 1,250.50.'
    : field === 'description' ? 'Escribe la nueva descripción, hasta 600 caracteres, o «Borrar descripción».'
    : 'Escribe el nuevo nombre, hasta 250 caracteres.';
  const promptId = field === 'is_active' ? null : await sendWhatsAppText(phone,
    `*Editar ${labels[field].toLowerCase()}*\n${treatment.name}\n\n*Actual*\n${display(field, previous)}\n\nResponde a este mensaje. ${guidance}`);
  const draft: Draft = {
    revision: randomUUID(), treatment_id: treatment.id, field, previous_value: previous,
    next_value: field === 'is_active' ? !treatment.is_active : null, prompt_id: promptId, expires_at: expiry(),
  };
  await drafts().upsert({ actor_phone: phone, ...draft }).throwOnError();
  if (!promptId) await showConfirmation(phone, treatment.name, draft);
}

function parseValue(field: Field, input: string): string | number | null {
  const value = input.trim();
  if (field === 'price') {
    if (!/^\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) return null;
    const price = Number(value.replace(/[$,\s]/g, ''));
    return Number.isSafeInteger(Math.round(price * 100)) ? price : null;
  }
  if (field === 'description' && normalized(value) === 'borrar descripcion') return '';
  return value && value.length <= (field === 'description' ? 600 : 250) ? value : null;
}

async function handleReply(phone: string, context: string, input: string) {
  const { data } = await drafts().select('*').eq('actor_phone', phone).eq('prompt_id', context).maybeSingle().throwOnError();
  if (!data) return false;
  const draft = data as Draft;
  if (Date.parse(draft.expires_at) <= Date.now()) {
    await expired(phone);
    return true;
  }
  const value = parseValue(draft.field, input);
  if (value === null) {
    await sendWhatsAppText(phone, `El valor para «${labels[draft.field]}» no es válido. Responde al mensaje original con el dato corregido.`);
    return true;
  }
  const treatment = await getTreatment(draft.treatment_id);
  const { data: updated } = await drafts().update({
    revision: randomUUID(), next_value: value, prompt_id: null, expires_at: expiry(),
  }).eq('actor_phone', phone).eq('revision', draft.revision).gt('expires_at', new Date().toISOString()).select('*').maybeSingle().throwOnError();
  if (treatment && updated) await showConfirmation(phone, treatment.name, updated as Draft);
  else await expired(phone);
  return true;
}

async function finishEdit(phone: string, revision: string, save: boolean) {
  const { data } = await drafts().delete().eq('actor_phone', phone).eq('revision', revision)
    .is('prompt_id', null).gt('expires_at', new Date().toISOString()).select('*').maybeSingle().throwOnError();
  if (!data) return expired(phone);
  if (!save) return sendWhatsAppText(phone, 'Cambio descartado.');

  const draft = data as Draft;
  const update = db.from('treatments').update({ [draft.field]: draft.next_value }).eq('id', draft.treatment_id);
  const checked = draft.previous_value === null ? update.is(draft.field, null) : update.eq(draft.field, draft.previous_value);
  const { data: saved, error } = await checked.select(columns).maybeSingle();
  if (error?.code === '23505') return sendWhatsAppText(phone, 'Ya existe un tratamiento visible con ese nombre. Abre la ficha para elegir un nombre distinto.');
  if (error) throw error;
  if (!saved) return sendWhatsAppText(phone, 'Ese dato cambió mientras revisabas la ficha. Abre la ficha actual antes de editarlo.');
  return showTreatment(phone, saved as Treatment, true);
}

export async function handleTreatmentEditor(phone: string, option: string | undefined, content: string, context?: string) {
  const command = !option && !context ? normalized(content) : '';
  if (option === 'adm_edit_treatment' || /^(?:editar tratamiento|administrar tratamientos)$/.test(command)) {
    await showTreatments(phone);
    return true;
  }
  const typedPage = command.match(/^pagina tratamientos ([1-9]\d{0,5})$/);
  if (typedPage) {
    await showTreatments(phone, Number(typedPage[1]) - 1);
    return true;
  }
  const typedCard = command.match(/^ficha tratamiento #?([1-9]\d{0,9})$/);
  const selection = typedCard ? `ted_card_${typedCard[1]}` : option;
  if (!selection) return context ? handleReply(phone, context, content) : false;
  const page = selection.match(/^ted_page_(\d{1,6})$/);
  const edit = selection.match(/^ted_(save|discard)_([\da-f-]{36})$/);
  const item = selection.match(/^ted_(card|fields|name|price|description|is_active)_([1-9]\d{0,9})$/);
  if (page) await showTreatments(phone, Number(page[1]));
  else if (edit) await finishEdit(phone, edit[2], edit[1] === 'save');
  else if (item) {
    const treatment = await getTreatment(Number(item[2]));
    if (!treatment) await expired(phone);
    else if (item[1] === 'card') await showTreatment(phone, treatment);
    else if (item[1] === 'fields') await sendWhatsAppInteractiveButtons({
      to: phone, bodyText: `*Editar datos*\n${treatment.name}\nElige el dato que quieres cambiar.`,
      buttons: (['description', 'price', 'name'] as const).map(field => ({
        id: `ted_${field}_${treatment.id}`, title: labels[field],
      })),
    });
    else await beginEdit(phone, treatment, item[1] as Field);
  } else return false;
  return true;
}
