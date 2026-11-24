alter table public.bot_settings add column clinic_name text check (char_length(btrim(clinic_name)) between 1 and 60);

create table public.clinic_weekly_hours (
  weekday smallint primary key check (weekday between 0 and 6),
  opens_at time,
  closes_at time,
  check ((opens_at is null and closes_at is null) or
    (opens_at is not null and closes_at is not null and opens_at < closes_at and closes_at < time '24:00'))
);
insert into public.clinic_weekly_hours (weekday, opens_at, closes_at)
values (0,null,null),(1,'13:00','17:00'),(2,'13:00','17:00'),(3,null,null),
       (4,'13:00','17:00'),(5,'13:00','17:00'),(6,null,null);

create table public.clinic_admin_inputs (
  actor_phone text primary key,
  id uuid not null,
  action text not null check (action in ('clinic_name','bot_name','hours','message','charge','payment')),
  target text not null,
  prompt_id text,
  value text,
  expires_at timestamptz not null,
  check ((prompt_id is null) <> (value is null))
);

create table public.patient_account_entries (
  id uuid primary key,
  phone text not null references public.patients(phone) on delete cascade,
  delta_cents integer not null check (delta_cents <> 0),
  note text not null check (char_length(btrim(note)) between 1 and 160),
  created_at timestamptz not null default now()
);
create index patient_account_entries_phone_idx on public.patient_account_entries(phone);

alter table public.clinic_weekly_hours enable row level security;
alter table public.clinic_admin_inputs enable row level security;
alter table public.patient_account_entries enable row level security;
revoke all on public.clinic_weekly_hours, public.clinic_admin_inputs, public.patient_account_entries from public, anon, authenticated;
grant select, update on public.clinic_weekly_hours to service_role;
grant select, insert, update, delete on public.clinic_admin_inputs to service_role;
grant select, insert on public.patient_account_entries to service_role;

create function public.patient_account_balance(p_phone text)
returns bigint language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(delta_cents),0) from public.patient_account_entries where phone = p_phone;
$$;

create function public.record_patient_account_entry(p_id uuid, p_phone text, p_delta integer, p_note text)
returns text language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.patients where phone = p_phone for update;
  if not found then return 'missing'; end if;
  if exists (select 1 from public.patient_account_entries where id = p_id) then return 'duplicate'; end if;
  if public.patient_account_balance(p_phone) + p_delta < 0 then return 'insufficient'; end if;
  insert into public.patient_account_entries (id, phone, delta_cents, note) values (p_id, p_phone, p_delta, p_note);
  return 'saved';
end;
$$;

revoke execute on function public.patient_account_balance(text) from public, anon, authenticated;
revoke execute on function public.record_patient_account_entry(uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.patient_account_balance(text) to service_role;
grant execute on function public.record_patient_account_entry(uuid,text,integer,text) to service_role;
