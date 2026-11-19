-- Schema for the Phase 1 WhatsApp clinic bot.
-- This script is safe to run more than once on a Supabase project.

create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists public.bot_settings (
  id integer primary key default 1 check (id = 1),
  bot_name text not null default 'Asistente Clínico',
  clinic_specialty text,
  updated_at timestamptz not null default now()
);

insert into public.bot_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.patients (
  phone text primary key,
  full_name text,
  age integer check (age is null or age >= 0),
  allergies_or_meds text,
  onboarding_completed boolean not null default false,
  chat_mode text not null default 'AI_ACTIVE'
    check (chat_mode in ('AI_ACTIVE', 'WAITING_HUMAN')),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  patient_phone text not null references public.patients(phone) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'doctor')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_patient_created_at_idx
  on public.chat_messages (patient_phone, created_at desc);

create table if not exists public.knowledge_base (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('precios', 'horarios', 'servicios', 'faq', 'ubicacion')),
  content text not null,
  embedding vector(1536),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_base_active_idx
  on public.knowledge_base (is_active);

create table if not exists public.clinic_tasks (
  id serial primary key,
  description text not null,
  is_completed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.escalation_mappings (
  wa_message_id text primary key,
  patient_phone text not null references public.patients(phone) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists escalation_mappings_patient_idx
  on public.escalation_mappings (patient_phone);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bot_settings_set_updated_at on public.bot_settings;
create trigger bot_settings_set_updated_at
before update on public.bot_settings
for each row execute function public.set_updated_at();

drop trigger if exists patients_set_updated_at on public.patients;
create trigger patients_set_updated_at
before update on public.patients
for each row execute function public.set_updated_at();

create or replace function public.match_knowledge(
  query_embedding vector(1536),
  match_threshold double precision default 0.78,
  match_count integer default 5
)
returns table (
  id uuid,
  category text,
  content text,
  similarity double precision
)
language sql
stable
as $$
  select
    kb.id,
    kb.category,
    kb.content,
    1 - (kb.embedding <=> query_embedding) as similarity
  from public.knowledge_base kb
  where kb.is_active = true
    and kb.embedding is not null
    and 1 - (kb.embedding <=> query_embedding) >= match_threshold
  order by kb.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;
