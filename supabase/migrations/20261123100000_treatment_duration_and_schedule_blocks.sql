alter table public.treatments add column duration_minutes smallint not null default 45
  check (duration_minutes between 15 and 480);

alter table public.treatment_edit_drafts drop constraint treatment_edit_drafts_field_check;
alter table public.treatment_edit_drafts add constraint treatment_edit_drafts_field_check
  check (field in ('name', 'price', 'description', 'is_active', 'duration_minutes'));

alter table public.clinic_admin_inputs drop constraint clinic_admin_inputs_action_check;
alter table public.clinic_admin_inputs add constraint clinic_admin_inputs_action_check
  check (action in ('clinic_name','bot_name','hours','message','charge','payment','patient_name','block_dates','block_hours'));

create table public.clinic_schedule_blocks (
  id uuid primary key,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at)
);
create index clinic_schedule_blocks_end_idx on public.clinic_schedule_blocks (ends_at);
alter table public.clinic_schedule_blocks enable row level security;
revoke all on public.clinic_schedule_blocks from public, anon, authenticated;
grant select, insert, delete on public.clinic_schedule_blocks to service_role;
