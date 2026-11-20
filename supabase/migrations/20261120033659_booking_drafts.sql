alter table public.treatments
  add column if not exists description text check (char_length(description) <= 600);

update public.treatments as t
set description = item.description
from (values
  ('limpieza dental', 'Consiste en retirar placa y sarro de la superficie de los dientes. Según la valoración, puede incluir pulido.'),
  ('resina dental', 'Se usa un material del color del diente para restaurar su forma cuando hay una caries o un daño pequeño. El dentista valora si la resina es adecuada.'),
  ('exodoncia', 'Es la extracción de un diente. El dentista revisa el caso y explica cómo se realizará el procedimiento antes de iniciarlo.'),
  ('cirugía dental', 'Incluye procedimientos quirúrgicos en dientes, encías u otros tejidos de la boca. El procedimiento y su alcance dependen de la valoración dental.'),
  ('aclaramiento dental', 'Es un procedimiento estético que busca aclarar el tono de los dientes. La valoración permite revisar si es adecuado y qué resultado se puede esperar.'),
  ('estudio radiográfico', 'Obtiene imágenes de los dientes, las raíces y el hueso para complementar la revisión clínica. El tipo de radiografía depende del motivo de consulta.')
) as item(name, description)
where lower(btrim(t.name)) = item.name and t.is_active and t.description is null;

create table if not exists public.booking_drafts (
  actor_phone text primary key,
  id uuid not null,
  revision uuid not null,
  stage text not null check (stage in ('search', 'options', 'name', 'contact', 'reason', 'confirm', 'processing', 'confirmed')),
  details jsonb not null,
  expires_at timestamptz not null
);
alter table public.booking_drafts enable row level security;
revoke all on public.booking_drafts from public, anon, authenticated;
grant select, insert, update, delete on public.booking_drafts to service_role;

comment on column public.treatments.description is 'Descripción informativa breve que se muestra en la ficha de WhatsApp.';
comment on table public.booking_drafts is 'Una reserva en curso por interlocutor. Cada revisión invalida los botones anteriores.';
