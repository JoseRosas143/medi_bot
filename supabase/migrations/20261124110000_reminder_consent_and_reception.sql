alter table public.patients
  add column reminder_whatsapp_allowed boolean,
  add column reminder_whatsapp_responded_at timestamptz,
  add constraint patients_reminder_preference_complete
    check ((reminder_whatsapp_allowed is null) = (reminder_whatsapp_responded_at is null));

alter table public.appointment_waitlist add column admin_notified_at timestamptz;
update public.appointment_waitlist set admin_notified_at = requested_at;
alter table public.waitlist_openings add column manual boolean not null default false;
alter table public.bot_settings add column admin_waitlist_template text;

alter table public.clinic_admin_inputs drop constraint clinic_admin_inputs_action_check;
alter table public.clinic_admin_inputs add constraint clinic_admin_inputs_action_check
  check (action in ('clinic_name','bot_name','hours','message','charge','payment','patient_name',
    'block_dates','block_hours','faq_add','faq_question','faq_answer','faq_hide','waitlist_day','waitlist_offer'));

create index patient_account_entries_statement_idx on public.patient_account_entries(phone, created_at desc, id);

create function public.patient_account_statement(p_phone text, p_offset integer)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'balance_cents', public.patient_account_balance(p_phone),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('delta_cents', item.delta_cents, 'note', item.note)
        order by item.created_at desc, item.id)
      from (
        select id, created_at, delta_cents, note
        from public.patient_account_entries
        where phone = p_phone
        order by created_at desc, id
        limit 6 offset greatest(p_offset, 0)
      ) as item
    ), '[]'::jsonb)
  );
$$;
revoke execute on function public.patient_account_statement(text,integer) from public, anon, authenticated;
grant execute on function public.patient_account_statement(text,integer) to service_role;
