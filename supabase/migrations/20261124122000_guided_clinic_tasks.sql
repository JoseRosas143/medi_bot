alter table public.clinic_admin_inputs drop constraint clinic_admin_inputs_action_check;
alter table public.clinic_admin_inputs add constraint clinic_admin_inputs_action_check
  check (action in ('clinic_name','bot_name','hours','message','charge','payment','patient_name',
    'block_dates','block_hours','faq_add','faq_question','faq_answer','faq_hide','waitlist_day','waitlist_offer','task_create'));

alter table public.clinic_tasks add column creation_token uuid unique;
