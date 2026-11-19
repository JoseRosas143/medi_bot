grant usage on sequence public.treatments_id_seq, public.faqs_id_seq, public.clinic_tasks_id_seq to service_role;

alter table public.bot_settings add column if not exists admin_last_inbound_at timestamptz;
insert into public.bot_settings (id, bot_name) values (1, 'Benson')
on conflict (id) do update set bot_name = excluded.bot_name;

alter table public.treatments
  alter column name set not null,
  alter column price set not null,
  add constraint treatments_name_has_text check (btrim(name) <> ''),
  add constraint treatments_price_finite_nonnegative check (price >= 0 and price < 'Infinity'::numeric);
alter table public.faqs
  alter column question set not null,
  alter column answer set not null,
  add constraint faqs_question_has_text check (btrim(question) <> ''),
  add constraint faqs_answer_has_text check (btrim(answer) <> '');

create unique index treatments_active_name_key on public.treatments (lower(btrim(name))) where is_active;
create unique index faqs_active_question_key on public.faqs (lower(btrim(question))) where is_active;
create index treatments_active_id_idx on public.treatments (id) where is_active;
create index faqs_active_id_idx on public.faqs (id) where is_active;

comment on table public.treatments is 'Catálogo de J R Dental. Precios en MXN y visibilidad en el menú de WhatsApp.';
comment on table public.faqs is 'Preguntas y respuestas aprobadas por la clínica para el menú de WhatsApp.';
comment on table public.appointment_notices is 'Registro de recordatorios y cancelaciones. La aceptación de Meta y la entrega se registran por separado.';
comment on table public.whatsapp_receipts is 'Mensajes entrantes de Meta procesados por Benson, identificados por su ID para evitar reintentos duplicados.';
comment on table public.pending_appointment_actions is 'Confirmaciones temporales de reserva y cancelación vinculadas al solicitante.';
comment on table public.calendar_booking_lock is 'Bloqueo temporal para serializar reservas de Benson en el calendario de la clínica.';
