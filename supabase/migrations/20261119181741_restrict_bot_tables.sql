alter table public.bot_settings enable row level security;
alter table public.patients enable row level security;
alter table public.chat_messages enable row level security;
alter table public.knowledge_base enable row level security;
alter table public.clinic_tasks enable row level security;
alter table public.escalation_mappings enable row level security;
alter table public.treatments enable row level security;
alter table public.faqs enable row level security;
revoke all on table public.bot_settings, public.patients, public.chat_messages, public.knowledge_base,
  public.clinic_tasks, public.escalation_mappings, public.treatments, public.faqs from public, anon, authenticated;
grant select, insert, update, delete on table public.bot_settings, public.patients, public.chat_messages, public.knowledge_base,
  public.clinic_tasks, public.escalation_mappings, public.treatments, public.faqs to service_role;
alter function public.set_updated_at() set search_path = pg_catalog;
alter function public.match_knowledge(public.vector, double precision, integer) set search_path = pg_catalog, public;
revoke execute on function public.match_knowledge(public.vector, double precision, integer) from public, anon, authenticated;
grant execute on function public.match_knowledge(public.vector, double precision, integer) to service_role;
