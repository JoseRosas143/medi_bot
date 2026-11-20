create table public.treatment_edit_drafts (
  actor_phone text primary key,
  revision uuid not null,
  treatment_id integer not null references public.treatments(id) on delete cascade,
  field text not null check (field in ('name', 'price', 'description', 'is_active')),
  previous_value jsonb,
  next_value jsonb,
  prompt_id text,
  expires_at timestamptz not null,
  check ((prompt_id is null) <> (next_value is null))
);

alter table public.treatment_edit_drafts enable row level security;
revoke all on public.treatment_edit_drafts from public, anon, authenticated;
grant select, insert, update, delete on public.treatment_edit_drafts to service_role;
