create table if not exists public.calendar_booking_lock (
  id integer primary key check (id = 1),
  holder uuid not null,
  expires_at timestamptz not null
);
alter table public.calendar_booking_lock enable row level security;
revoke all on public.calendar_booking_lock from public, anon, authenticated;
grant select, insert, update, delete on public.calendar_booking_lock to service_role;
