create table public.appointment_waitlist (
  event_id text primary key,
  id uuid not null default gen_random_uuid(),
  phone text not null references public.patients(phone) on delete cascade,
  original_start timestamptz not null,
  original_end timestamptz not null,
  duration_seconds integer generated always as (extract(epoch from (original_end - original_start))::integer) stored,
  requested_at timestamptz not null default now(),
  check (original_end > original_start)
);
create index appointment_waitlist_order_idx on public.appointment_waitlist (requested_at, id);

create table public.waitlist_openings (
  id uuid primary key default gen_random_uuid(),
  revision uuid not null default gen_random_uuid(),
  source_event_id text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  state text not null default 'open' check (state in ('open','offered','processing','closed')),
  attempted_ids uuid[] not null default '{}',
  candidate_id uuid,
  candidate_event_id text,
  candidate_phone text,
  offer_id uuid unique,
  deadline timestamptz,
  checked_at timestamptz not null default '-infinity',
  check (end_at > start_at)
);
create unique index waitlist_one_active_opening_idx on public.waitlist_openings (start_at) where state <> 'closed';
create unique index waitlist_one_offer_per_phone_idx on public.waitlist_openings (candidate_phone) where state in ('offered','processing');
create index waitlist_dispatch_idx on public.waitlist_openings (state, start_at, deadline);

create table public.waitlist_calendar_snapshot (
  id boolean primary key check (id),
  captured_at timestamptz not null,
  appointments jsonb not null
);

alter table public.appointment_waitlist enable row level security;
alter table public.waitlist_openings enable row level security;
alter table public.waitlist_calendar_snapshot enable row level security;
revoke all on public.appointment_waitlist, public.waitlist_openings, public.waitlist_calendar_snapshot from public, anon, authenticated;
grant select, insert, update, delete on public.appointment_waitlist, public.waitlist_openings, public.waitlist_calendar_snapshot to service_role;

create function public.observe_waitlist_calendar(p_captured_at timestamptz, p_window_end timestamptz, p_appointments jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  previous public.waitlist_calendar_snapshot%rowtype;
begin
  insert into public.waitlist_calendar_snapshot (id, captured_at, appointments)
    values (true, p_captured_at, p_appointments) on conflict (id) do nothing;
  select * into previous from public.waitlist_calendar_snapshot where id = true for update;
  if previous.captured_at >= p_captured_at then return; end if;

  insert into public.waitlist_openings (source_event_id, start_at, end_at)
  select old.event_id, old.start_at, old.end_at
  from jsonb_to_recordset(previous.appointments) as old(event_id text, start_at timestamptz, end_at timestamptz)
  where old.start_at > p_captured_at and old.start_at < p_window_end
    and not exists (
      select 1 from jsonb_to_recordset(p_appointments) as recent(event_id text, start_at timestamptz, end_at timestamptz)
      where recent.start_at <= old.start_at and recent.end_at > old.start_at
    )
  on conflict do nothing;

  update public.waitlist_calendar_snapshot set captured_at = p_captured_at, appointments = p_appointments where id = true;
end;
$$;
revoke execute on function public.observe_waitlist_calendar(timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.observe_waitlist_calendar(timestamptz, timestamptz, jsonb) to service_role;

alter table public.appointment_notices
  drop constraint appointment_notices_kind_check,
  drop constraint appointment_notices_state_check;
alter table public.appointment_notices
  add constraint appointment_notices_kind_check check (kind in ('reminder','cancellation','booking_admin')),
  add constraint appointment_notices_state_check check (state in ('queued','sending','accepted','rejected','uncertain','delivered','failed'));
create index appointment_notices_queued_idx on public.appointment_notices (scheduled_start) where kind = 'booking_admin' and state = 'queued';

alter table public.bot_settings
  add column waitlist_template text,
  add column admin_booking_template text;
