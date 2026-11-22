create table public.waitlist_offer_history (
  offer_id uuid primary key,
  request_id uuid not null,
  phone text not null references public.patients(phone) on delete cascade,
  start_at timestamptz not null,
  deadline timestamptz,
  created_at timestamptz not null default now(),
  status text not null check (status in ('sending','sent','unknown','send_error','accepted','declined','expired','withdrawn','unavailable'))
);

create index waitlist_offer_history_request_idx on public.waitlist_offer_history (request_id, created_at desc, offer_id);
create index waitlist_offer_history_recent_idx on public.waitlist_offer_history (created_at desc, offer_id);

alter table public.waitlist_offer_history enable row level security;
revoke all on public.waitlist_offer_history from public, anon, authenticated;
grant select, insert, update on public.waitlist_offer_history to service_role;

insert into public.waitlist_offer_history (offer_id, request_id, phone, start_at, deadline, status)
select o.offer_id, o.candidate_id, o.candidate_phone, o.start_at, o.deadline,
  case when o.state = 'closed' then 'accepted' else 'unknown' end
from public.waitlist_openings o
join public.patients p on p.phone = o.candidate_phone
where o.offer_id is not null and o.candidate_id is not null;
