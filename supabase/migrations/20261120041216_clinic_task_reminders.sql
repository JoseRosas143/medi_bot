alter table public.clinic_tasks
  add column reminder_at timestamptz,
  add column reminder_state text,
  add column reminder_attempted_at timestamptz,
  add column reminder_message_id text,
  add constraint clinic_tasks_reminder_state_check check (
    reminder_state in ('scheduled', 'sending', 'accepted', 'delivered', 'rejected', 'failed', 'uncertain')
  ),
  add constraint clinic_tasks_reminder_schedule_check check (
    (reminder_at is null) = (reminder_state is null)
  );

alter table public.bot_settings
  add column task_reminder_template text;

create index clinic_tasks_due_reminders_idx on public.clinic_tasks (reminder_at, id)
  where is_completed = false and reminder_state = 'scheduled';

create unique index clinic_tasks_reminder_message_idx on public.clinic_tasks (reminder_message_id)
  where reminder_message_id is not null;
