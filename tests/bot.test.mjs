import { strict as assert } from 'node:assert';
import { createHmac, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const databaseUrl = 'data:text/javascript,export const supabaseAdmin=globalThis.testDatabase';
const googleUrl = 'data:text/javascript,export const google=globalThis.testGoogle';
const calendarUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const { getUpcomingSlots, getAvailableSlots, createCalendarAppointment, findCalendarBooking,
    cancelCalendarEvent, getPatientAppointments, findUpcomingAppointmentsByWhatsApp, getAppointmentsByDateRange, appointmentPatientName,
    getCalendarAppointment, moveCalendarAppointment, confirmCalendarAttendance, appointmentMatchesSlot,
    saveCalendarAppointmentContact, recordCalendarVisit } = globalThis.testCalendar;
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/supabase') return { shortCircuit: true, url: databaseUrl };
    if (specifier === '@/lib/calendar') return { shortCircuit: true, url: calendarUrl };
    if (specifier === 'googleapis') return { shortCircuit: true, url: googleUrl };
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    return nextResolve(specifier, context);
  },
});

process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '12345678';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
process.env.ADMIN_PHONE_NUMBER = '525500000001';
process.env.CLINIC_TIMEZONE = 'America/Mexico_City';

const metaRequests = [];
const receipts = new Set();
const notices = new Set();
const reminderReplies = new Map();
const saved = [];
const bookingDrafts = new Map();
const treatmentDrafts = new Map();
const waitEntries = new Map();
const waitOpenings = new Map();
const bookingNotices = new Map();
const lastInbounds = new Map();
let adminLastInbound = null;
const clinicTasks = new Map();
let taskReminderTemplate = null;
const createdAppointments = [];
let upcomingAppointments = [];
const events = new Map();
const pendingAppointmentActions = new Map();
const patientNames = new Map();
const calendarPatches = [];
let busyPeriods = [];
let persistCalendarWrites = true;
const mockCalendarId = 'test-calendar';
process.env.GOOGLE_CALENDAR_ID = mockCalendarId;
process.env.GOOGLE_PRIVATE_KEY = 'test-google-key';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@demo.invalid';
globalThis.testGoogle = {
  auth: { JWT: class {} },
  calendar: () => ({
    freebusy: { query: async () => ({ data: { calendars: { [mockCalendarId]: { busy: busyPeriods } } } }) },
    events: {
      get: async ({ eventId }) => {
        if (!events.has(eventId)) throw Object.assign(new Error('Missing event'), { code: 404 });
        return { data: structuredClone(events.get(eventId)) };
      },
      list: async ({ privateExtendedProperty, timeMin, timeMax, eventTypes }) => ({
        data: { items: [...events.values()].filter(event =>
          (!privateExtendedProperty || privateExtendedProperty.includes(`patientPhone=${event.extendedProperties?.private?.patientPhone}`)) &&
          (!eventTypes || (
            eventTypes.includes(event.eventType || 'default') &&
            Date.parse(event.end.dateTime) > Date.parse(timeMin) &&
            Date.parse(event.start.dateTime) < Date.parse(timeMax)
          ))) },
      }),
      insert: async ({ requestBody }) => {
        if (persistCalendarWrites) events.set(requestBody.id, requestBody);
        return { data: requestBody };
      },
      patch: async ({ eventId, requestBody }, options) => {
        const event = events.get(eventId);
        assert.equal(options.headers['If-Match'], event.etag);
        calendarPatches.push({ eventId, requestBody });
        const updated = { ...event, ...requestBody, etag: `v${calendarPatches.length + 1}` };
        if (persistCalendarWrites) events.set(eventId, updated);
        return { data: updated };
      },
      delete: async ({ eventId }, options) => {
        assert.equal(options.headers['If-Match'], events.get(eventId).etag);
        events.delete(eventId);
      },
    },
  }),
};
const liveCalendar = await import('../src/lib/calendar.ts');
const calendarSlots = ['16:00', '17:00', '18:00'].map(hour => ({
  start: `2099-11-20T${hour}:00-06:00`,
  end: `2099-11-20T${hour.replace(':00', ':45')}:00-06:00`,
  label: `Viernes a las ${hour}`,
}));
globalThis.testCalendar = {
  getUpcomingSlots: async (_after, duration) => duration ? calendarSlots.map(slot => ({
    ...slot, end: new Date(Date.parse(slot.start) + duration).toISOString(),
  })) : calendarSlots,
  getAvailableSlots: async date => ({ date, slots: calendarSlots }),
  createCalendarAppointment: async params => {
    createdAppointments.push(params);
    return calendarSlots.find(slot => slot.start === params.startTime);
  },
  getPatientAppointments: liveCalendar.getPatientAppointments,
  findUpcomingAppointmentsByWhatsApp: liveCalendar.findUpcomingAppointmentsByWhatsApp,
  getAppointmentsByDateRange: async (...args) => events.size ? liveCalendar.getAppointmentsByDateRange(...args) : upcomingAppointments,
  getCalendarAppointment: liveCalendar.getCalendarAppointment,
  cancelCalendarEvent: liveCalendar.cancelCalendarEvent,
  saveCalendarAppointmentContact: liveCalendar.saveCalendarAppointmentContact,
  recordCalendarVisit: liveCalendar.recordCalendarVisit,
  appointmentMatchesSlot: liveCalendar.appointmentMatchesSlot,
  moveCalendarAppointment: liveCalendar.moveCalendarAppointment,
  confirmCalendarAttendance: liveCalendar.confirmCalendarAttendance,
  appointmentPatientName: summary => summary.replace(/^Cita: /, ''),
};
const treatments = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1, price: 100.5 + i, name: `Tratamiento de muestra número ${i + 1}`,
  description: 'Descripción informativa de la clínica.', is_active: true,
}));

function query(table) {
  let operation = 'select';
  let values;
  const filters = {};
  const constraints = [];
  let singleRow = false;
  let limit;
  let sort;
  const sorts = [];
  let range;
  const chain = {
    select: () => chain,
    order: (field, options) => { sort = { field, ascending: options?.ascending !== false }; sorts.push(sort); return chain; },
    maybeSingle: () => { singleRow = true; return chain; },
    single: () => { singleRow = true; return chain; },
    or: rule => {
      if (rule === 'reminder_state.is.null,reminder_state.neq.sending') constraints.push(row => row.reminder_state !== 'sending');
      return chain;
    },
    eq: (field, value) => { filters[field] = value; return chain; },
    in: (field, choices) => { constraints.push(row => choices.includes(row[field])); return chain; },
    lt: (field, value) => { constraints.push(row => readField(row, field) != null && readField(row, field) < value); return chain; },
    lte: (field, value) => { constraints.push(row => readField(row, field) != null && readField(row, field) <= value); return chain; },
    not: (field, _operator, value) => {
      constraints.push(row => !value.slice(1, -1).split(',').includes(readField(row, field)));
      return chain;
    },
    limit: value => { limit = value; return chain; },
    match: values => { Object.assign(filters, values); return chain; },
    gt: (field, value) => { constraints.push(row => readField(row, field) > value); return chain; },
    delete: () => { operation = 'delete'; return chain; },
    is: (field, value) => { filters[field] = value; return chain; },
    insert: value => { operation = 'insert'; values = value; return chain; },
    upsert: value => { operation = 'upsert'; values = value; return chain; },
    update: value => { operation = 'update'; values = value; return chain; },
    range: (from, to) => { range = [from, to]; return chain; },
    throwOnError: () => chain,
    then: resolve => {
      if (table === 'bot_settings' && operation === 'select') {
        return resolve({ data: { task_reminder_template: taskReminderTemplate, admin_last_inbound_at: adminLastInbound }, error: null });
      }
      if (table === 'appointment_waitlist' || table === 'waitlist_openings') {
        const isEntry = table === 'appointment_waitlist';
        const storage = isEntry ? waitEntries : waitOpenings;
        if (operation === 'insert') {
          if (isEntry && storage.has(values.event_id) || !isEntry &&
              [...storage.values()].some(row => row.start_at === values.start_at && row.state !== 'closed')) {
            return resolve({ data: null, error: { code: '23505' } });
          }
          const row = isEntry ? { ...values } : {
            id: randomUUID(), revision: randomUUID(), state: 'open', attempted_ids: [], deadline: null, checked_at: '', ...values,
          };
          storage.set(isEntry ? values.event_id : row.id, row);
          return resolve({ data: { ...row }, error: null });
        }
        let rows = [...storage.entries()].map(([key, row]) => [key, isEntry ? {
          ...row, duration_seconds: (Date.parse(row.original_end) - Date.parse(row.original_start)) / 1000,
          patients: { chat_mode: 'AI_ACTIVE', last_inbound_at: lastInbounds.get(row.phone) ?? new Date(Date.now() - 1000).toISOString() },
        } : { ...row }]).filter(([, row]) =>
          Object.entries(filters).every(([field, value]) => readField(row, field) === value) && constraints.every(check => check(row)));
        for (const { field, ascending } of [...sorts].reverse()) rows.sort(([, a], [, b]) =>
          (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (ascending ? 1 : -1));
        if (limit) rows = rows.slice(0, limit);
        if (operation === 'update') {
          if (!isEntry && values.state === 'offered' && [...storage.values()].some(row =>
            row.id !== filters.id && row.candidate_phone === values.candidate_phone && ['offered', 'processing'].includes(row.state))) {
            return resolve({ data: null, error: { code: '23505' } });
          }
          for (const [key, row] of rows) {
            Object.assign(row, values);
            Object.assign(storage.get(key), values);
          }
        }
        if (operation === 'delete') rows.forEach(([key]) => storage.delete(key));
        return resolve({ data: singleRow ? rows[0]?.[1] ?? null : rows.map(([, row]) => row), error: null });
      }
      if (table === 'clinic_tasks') {
        if (operation === 'insert') {
          const id = clinicTasks.size + 1;
          const row = { id, is_completed: false, reminder_at: null, reminder_state: null, ...values };
          clinicTasks.set(id, row);
          return resolve({ data: row, error: null });
        }
        let rows = [...clinicTasks.values()].filter(row =>
          Object.entries(filters).every(([field, value]) => row[field] === value) && constraints.every(check => check(row)),
        );
        if (operation === 'update') rows.forEach(row => Object.assign(row, values));
        if (sort) {
          rows.sort((a, b) => Number(a[sort.field] > b[sort.field]) - Number(a[sort.field] < b[sort.field]));
          if (!sort.ascending) rows.reverse();
        }
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (limit) rows = rows.slice(0, limit);
        return resolve({ data: singleRow ? rows[0] ?? null : rows, error: null });
      }
      if (table === 'booking_drafts') {
        if (operation === 'insert') {
          if (bookingDrafts.has(values.actor_phone)) return resolve({ error: { code: '23505' } });
          bookingDrafts.set(values.actor_phone, values);
          return resolve({ error: null });
        }
        const row = bookingDrafts.get(filters.actor_phone);
        if (operation === 'update') {
          if (!row || row.revision !== filters.revision) return resolve({ data: null, error: null });
          const updated = { ...row, ...values };
          bookingDrafts.set(filters.actor_phone, updated);
          return resolve({ data: updated, error: null });
        }
        return resolve({ data: row || null, error: null });
      }
      if (table === 'treatment_edit_drafts') {
        if (operation === 'upsert') {
          treatmentDrafts.set(values.actor_phone, { ...values });
          return resolve({ data: null, error: null });
        }
        const row = treatmentDrafts.get(filters.actor_phone);
        if (!row || !Object.entries(filters).every(([key, value]) => row[key] === value) ||
            !constraints.every(check => check(row))) return resolve({ data: null, error: null });
        if (operation === 'update') Object.assign(row, values);
        if (operation === 'delete') treatmentDrafts.delete(filters.actor_phone);
        return resolve({ data: { ...row }, error: null });
      }
      if (table === 'pending_appointment_actions') {
        if (operation === 'insert') {
          const id = randomUUID();
          const row = { id, handled_at: null, expires_at: new Date(Date.now() + 900_000).toISOString(), ...values };
          pendingAppointmentActions.set(id, row);
          return resolve({ data: row, error: null });
        }
        const row = [...pendingAppointmentActions.values()].find(row =>
          Object.entries(filters).every(([key, value]) =>
            (key === 'details->>contactPromptId' ? row.details.contactPromptId : row[key]) === value) &&
          constraints.every(check => check(row)));
        if (!row) {
          return resolve({ data: null, error: null });
        }
        if (operation === 'update') Object.assign(row, values);
        return resolve({ data: row, error: null });
      }
      if (table === 'whatsapp_receipts' && operation === 'insert') {
        if (receipts.has(values.message_id)) return resolve({ error: { code: '23505' } });
        receipts.add(values.message_id);
      }
      if (table === 'appointment_notices' && operation === 'insert') {
        const key = JSON.stringify(values);
        if (notices.has(key)) return resolve({ error: { code: '23505' } });
        notices.add(key);
      }
      if (table === 'appointment_notices' && (values?.kind === 'booking_admin' || filters.kind === 'booking_admin')) {
        if (operation === 'upsert') {
          if (!bookingNotices.has(values.event_id)) bookingNotices.set(values.event_id, { ...values });
          return resolve({ data: null, error: null });
        }
        const rows = [...bookingNotices.values()].filter(row =>
          Object.entries(filters).every(([field, value]) => row[field] === value) && constraints.every(check => check(row)));
        if (operation === 'update') rows.forEach(row => Object.assign(row, values));
        return resolve({ data: singleRow ? rows[0] ?? null : rows.slice(0, limit), error: null });
      }
      if (table === 'appointment_notices' && operation === 'select') {
        return resolve({ data: reminderReplies.get(filters.wa_message_id) || null, error: null });
      }
      if (table === 'patients' && operation === 'select') {
        return resolve({ data: {
          phone: filters.phone, full_name: patientNames.get(filters.phone) ?? 'Ana Demo',
          chat_mode: 'AI_ACTIVE', human_session_id: null,
        } });
      }
      if (table === 'chat_messages' && operation === 'insert') saved.push(values);
      if (table === 'treatments') {
        let rows = treatments.filter(row =>
          Object.entries(filters).every(([key, value]) => row[key] === value) && constraints.every(check => check(row)));
        if (operation === 'update') rows.forEach(row => Object.assign(row, values));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return resolve({ data: singleRow ? rows[0] ?? null : rows, error: null });
      }
      return resolve({ data: null, error: null });
    },
  };
  return chain;
}
const readField = (row, field) => field.split('.').reduce((value, part) => value?.[part], row);
globalThis.testDatabase = { from: query, rpc: () => ({ throwOnError: async () => ({ error: null }) }) };
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/graph\.facebook\.com\//);
  metaRequests.push(JSON.parse(options.body));
  return Response.json({ messages: [{ id: `mock_${metaRequests.length}` }] });
};

const { POST: whatsapp } = await import('../src/app/api/webhook/whatsapp/route.ts');
const { GET: reminders } = await import('../src/app/api/cron/reminders/route.ts');
const { clinicDate, clinicDayRange, nextDate, reminderWindow } = await import('../src/lib/clinic-time.ts');
const { showCatalog, showAdminMenu } = await import('../src/lib/menus.ts');
const { sendAppointmentNotice } = await import('../src/lib/appointment-notices.ts');
const { dispatchAdminBookingNotice, queueAdminBookingNotice } = await import('../src/lib/admin-booking-notices.ts');
const { offerReleasedAppointment, runWaitlist } = await import('../src/lib/waitlist.ts');
const { proposeAppointmentAction } = await import('../src/lib/appointment-actions.ts');
const { addClinicTask, scheduleClinicTask } = await import('../src/lib/clinic-tasks.ts');
const { transcribeWhatsAppAudio } = await import('../src/lib/audio.ts');
const patient = '525500000002';

function webhook(messages, sign = true, displayPhone = '525500000099', statuses = []) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '12345678', display_phone_number: displayPhone }, messages, statuses,
    } }] }],
  });
  const signature = createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(body).digest('hex');
  return whatsapp(new Request('https://clinic.test/api/webhook/whatsapp', {
    method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${sign ? signature : '0'.repeat(64)}` },
  }));
}

test('rejects an unsigned-as-trusted request before touching the database', async () => {
  const before = receipts.size;
  const response = await webhook([{ id: 'forged', from: process.env.ADMIN_PHONE_NUMBER, type: 'text', text: { body: 'Ayuda' } }], false);
  assert.equal(response.status, 403);
  assert.equal(receipts.size, before);
});

test('processes all messages in a batch and routes by option ID on redelivery', async () => {
  const messages = [
    { id: 'patient-options', from: patient, type: 'interactive', interactive: { list_reply: { id: 'menu_tratamientos', title: 'Recortado' } } },
    { id: 'admin-panel', from: process.env.ADMIN_PHONE_NUMBER, type: 'text', text: { body: 'Ayuda' } },
    { id: 'patient-detail', from: patient, type: 'interactive', interactive: { list_reply: { id: 'trt_3', title: 'Recortado' } } },
  ];
  const before = metaRequests.length;
  assert.equal((await webhook(messages)).status, 200);
  assert.equal((await webhook(messages)).status, 200);
  const [catalog, admin, detail] = metaRequests.slice(before);
  assert.equal(metaRequests.length - before, 3);
  assert.equal(catalog.interactive.action.sections[0].rows[0].id, 'trt_1');
  assert.equal(admin.to, process.env.ADMIN_PHONE_NUMBER);
  assert.match(detail.interactive.body.text, /Tratamiento de muestra número 3/);
  assert.match(detail.interactive.body.text, /102\.50/);
  assert.match(detail.interactive.body.text, /Descripción informativa/);
  assert.equal(detail.interactive.action.buttons[0].reply.id, 'book_trt_3');
  assert.match(saved.at(-1).content, /102\.50/);
});

test('catalog and admin lists fit Meta limits and leave space for navigation', async () => {
  await showCatalog(patient, 'treatments', 1);
  await showAdminMenu(process.env.ADMIN_PHONE_NUMBER);
  const [catalog, admin] = metaRequests.slice(-2);
  for (const { interactive } of [catalog, admin]) {
    const { sections, button } = interactive.action;
    assert.ok(button.length <= 20);
    assert.ok(sections.flatMap(section => section.rows).length <= 10);
    for (const section of sections) {
      assert.ok(section.title.length <= 24);
      for (const row of section.rows) {
        assert.ok(row.title.length <= 24);
        assert.ok((row.description?.length || 0) <= 72);
      }
    }
  }
  assert.deepEqual(catalog.interactive.action.sections[1].rows.map(row => row.id), ['trt_page_0', 'menu_principal']);
  assert.ok(admin.interactive.action.sections.some(section => section.rows.some(row => row.id === 'admin_booking')));
});

function textMessage(id, body, from = patient) {
  return { id, from, type: 'text', text: { body } };
}

function answerButton(id, button, from = patient) {
  return { id, from, type: 'interactive', interactive: { button_reply: { id: button, title: 'Opción' } } };
}

function lastButtons() {
  const { buttons, sections } = metaRequests.at(-1).interactive.action;
  return buttons ? buttons.map(button => button.reply.id) : sections.flatMap(section => section.rows.map(row => row.id));
}

function seedWaitlistAppointment(id, phone, hour) {
  const event = {
    id, etag: 'v1', summary: 'Cita: Ana Demo', description: 'Conservar este detalle',
    start: { dateTime: `2099-11-20T${hour}:00:00-06:00` },
    end: { dateTime: `2099-11-20T${hour}:45:00-06:00` },
    extendedProperties: { private: { patientPhone: phone, attendanceConfirmedFor: `2099-11-20T${hour}:00:00-06:00` } },
  };
  events.set(id, event);
  return event;
}

async function joinWaitlist(phone, tag) {
  await webhook([textMessage(`wait-menu-${tag}`, 'Lista de espera', phone)]);
  await webhook([answerButton(`wait-detail-${tag}`, lastButtons().find(id => id.startsWith('appt_wait_')), phone)]);
  await webhook([answerButton(`wait-enroll-${tag}`, lastButtons().find(id => id.startsWith('appt_wait_join_')), phone)]);
  assert.match(metaRequests.at(-1).text.body, /lista de espera/);
}

test('waitlist offers a cancelled slot in FIFO order and moves only the patient who accepts', async () => {
  const second = '525500000033';
  const firstEvent = seedWaitlistAppointment('wait-first', patient, '17');
  const secondEvent = seedWaitlistAppointment('wait-second', second, '18');
  const cancelled = seedWaitlistAppointment('wait-opening', '525500000044', '16');
  const admin = process.env.ADMIN_PHONE_NUMBER;
  process.env.WHATSAPP_WAITLIST_TEMPLATE = 'cita_adelanto_lista_espera';
  try {
    await joinWaitlist(patient, 'first');
    await joinWaitlist(second, 'second');
    lastInbounds.set(second, new Date(Date.now() - 90_000_000).toISOString());
    const expected = await liveCalendar.getCalendarAppointment(cancelled.id);
    await proposeAppointmentAction(admin, { action: 'cancel_clinic', details: expected });
    await webhook([answerButton('cancel-for-waitlist', lastButtons().find(id => id.startsWith('appointment_only_')), admin)]);
    assert.equal(events.has(cancelled.id), false);
    assert.equal(metaRequests.at(-1).to, patient);
    assert.equal(metaRequests.at(-1).interactive.type, 'button');
    assert.equal(events.get(firstEvent.id).start.dateTime, firstEvent.start.dateTime);
    await webhook([answerButton('decline-first-wait-offer', lastButtons()[1], patient)]);
    const offer = metaRequests.at(-1);
    assert.equal(offer.to, second);
    assert.equal(offer.template.name, 'cita_adelanto_lista_espera');
    const accept = offer.template.components.find(component => component.type === 'button').parameters[0].payload;
    await webhook([answerButton('wrong-patient-cannot-accept', accept, patient)]);
    assert.equal(events.get(secondEvent.id).start.dateTime, secondEvent.start.dateTime);
    const reply = id => ({ id, from: second, type: 'button', button: { payload: accept, text: 'Aceptar horario' } });
    const patches = calendarPatches.length;
    await Promise.all([webhook([reply('accept-second-wait-offer')]), webhook([reply('repeat-second-wait-offer')])]);
    assert.equal(calendarPatches.length, patches + 1);
    assert.equal(events.get(secondEvent.id).start.dateTime, '2099-11-20T22:00:00.000Z');
    assert.equal(events.get(secondEvent.id).description, secondEvent.description);
    assert.equal(events.get(firstEvent.id).start.dateTime, firstEvent.start.dateTime);
    assert.equal(waitEntries.has(secondEvent.id), false);
  } finally {
    delete process.env.WHATSAPP_WAITLIST_TEMPLATE;
    pendingAppointmentActions.clear();
    lastInbounds.clear();
    waitEntries.clear();
    waitOpenings.clear();
    events.clear();
  }
});

test('expired waitlist offers pass to the next patient and an occupied slot preserves the original appointment', async () => {
  const second = '525500000033';
  seedWaitlistAppointment('wait-expire-first', patient, '17');
  const original = seedWaitlistAppointment('wait-occupied-second', second, '18');
  const cancelled = seedWaitlistAppointment('wait-release-later-occupied', '525500000044', '16');
  try {
    await joinWaitlist(patient, 'expires');
    await joinWaitlist(second, 'still-available');
    const expected = await liveCalendar.getCalendarAppointment(cancelled.id);
    events.delete(cancelled.id);
    await offerReleasedAppointment(expected);
    const firstOffer = [...waitOpenings.values()][0];
    firstOffer.deadline = new Date(Date.now() - 1000).toISOString();
    await runWaitlist();
    assert.equal(metaRequests.at(-1).to, second);
    const accept = lastButtons()[0];
    busyPeriods = [{ start: '2099-11-20T22:00:00Z', end: '2099-11-20T22:45:00Z' }];
    await webhook([answerButton('wait-slot-no-longer-free', accept, second)]);
    assert.match(metaRequests.at(-1).text.body, /ya no está disponible/);
    assert.equal(events.get(original.id).start.dateTime, original.start.dateTime);
  } finally {
    busyPeriods = [];
    waitEntries.clear();
    waitOpenings.clear();
    events.clear();
  }
});

test('reception gets one same-day booking alert and closed windows use the approved utility template', async () => {
  const today = new Date().toISOString();
  const admin = process.env.ADMIN_PHONE_NUMBER;
  const before = metaRequests.length;
  adminLastInbound = new Date(Date.now() - 1000).toISOString();
  try {
    await queueAdminBookingNotice('alert-same-day', today);
    await Promise.all([dispatchAdminBookingNotice('alert-same-day', today), dispatchAdminBookingNotice('alert-same-day', today)]);
    assert.equal(metaRequests.length, before + 1);
    assert.equal(metaRequests.at(-1).to, admin);
    assert.match(metaRequests.at(-1).text.body, /Para hoy/);
    adminLastInbound = null;
    await queueAdminBookingNotice('alert-closed-window', today);
    await dispatchAdminBookingNotice('alert-closed-window', today);
    assert.equal(bookingNotices.get('alert-closed-window').state, 'queued');
    process.env.WHATSAPP_ADMIN_BOOKING_TEMPLATE = 'cita_nueva_recepcion';
    await dispatchAdminBookingNotice('alert-closed-window', today);
    assert.equal(metaRequests.at(-1).template.name, 'cita_nueva_recepcion');
    assert.equal(metaRequests.at(-1).to, admin);
  } finally {
    adminLastInbound = null;
    delete process.env.WHATSAPP_ADMIN_BOOKING_TEMPLATE;
    bookingNotices.clear();
  }
});

test('reception reviews a treatment description before saving and patients see the saved ficha', async () => {
  const treatment = treatments[0];
  const original = treatment.description;
  const admin = process.env.ADMIN_PHONE_NUMBER;
  try {
    await webhook([answerButton('admin-treatment-editor', 'adm_edit_treatment', admin)]);
    const rows = metaRequests.at(-1).interactive.action.sections.flatMap(section => section.rows);
    assert.ok(rows.some(row => row.id === 'ted_card_1'));
    await webhook([answerButton('admin-treatment-card', 'ted_card_1', admin)]);
    assert.match(metaRequests.at(-1).interactive.body.text, /Descripción informativa/);
    await webhook([answerButton('admin-treatment-fields', 'ted_fields_1', admin)]);
    assert.ok(lastButtons().includes('ted_price_1'));
    await webhook([answerButton('admin-treatment-description', 'ted_description_1', admin)]);
    const promptId = `mock_${metaRequests.length}`;
    const description = 'Incluye una revisión y una explicación del procedimiento.';
    await webhook([{ ...textMessage('admin-description-reply', description, admin), context: { id: promptId } }]);
    assert.equal(treatment.description, original);
    assert.match(metaRequests.at(-1).interactive.body.text, /\*Propuesto\*/);
    const save = lastButtons()[0];
    await webhook([answerButton('wrong-actor-treatment-save', save, patient)]);
    assert.equal(treatment.description, original);
    await webhook([answerButton('confirm-treatment-description', save, admin)]);
    assert.equal(treatment.description, description);
    assert.match(metaRequests.at(-1).interactive.body.text, /Cambio guardado/);
    await webhook([answerButton('patient-reads-treatment-update', 'trt_1', patient)]);
    assert.match(metaRequests.at(-1).interactive.body.text, /Incluye una revisión/);
  } finally {
    treatment.description = original;
    treatmentDrafts.clear();
  }
});

test('reception can hide and restore a ficha without overwriting newer changes', async () => {
  const treatment = treatments[0];
  const admin = process.env.ADMIN_PHONE_NUMBER;
  try {
    await webhook([answerButton('admin-hide-treatment', 'ted_is_active_1', admin)]);
    assert.equal(treatment.is_active, true);
    const stale = lastButtons()[0];
    treatment.is_active = false;
    await webhook([answerButton('admin-confirms-stale-visibility', stale, admin)]);
    assert.match(metaRequests.at(-1).text.body, /cambió mientras revisabas/);
    await showCatalog(patient, 'treatments');
    assert.equal(metaRequests.at(-1).interactive.action.sections.flatMap(section => section.rows).some(row => row.id === 'trt_1'), false);
    await webhook([answerButton('admin-restore-treatment', 'ted_is_active_1', admin)]);
    await webhook([answerButton('admin-confirms-restored-visibility', lastButtons()[0], admin)]);
    assert.equal(treatment.is_active, true);
  } finally {
    treatment.is_active = true;
    treatmentDrafts.clear();
  }
});

function appointmentOptions() {
  const { action } = metaRequests.at(-1).interactive;
  return action.sections ? action.sections.flatMap(section => section.rows.map(row => row.id)) : lastButtons();
}

function seedPatientAppointment() {
  const event = {
    id: 'calendar-existing-event',
    etag: 'v1',
    summary: 'Cita: Ana Demo',
    description: 'Motivo original',
    visibility: 'private',
    start: { dateTime: '2099-11-20T16:00:00-06:00' },
    end: { dateTime: '2099-11-20T17:00:00-06:00' },
    extendedProperties: { private: { patientPhone: patient, clinicMetadata: 'original' } },
  };
  events.set(event.id, event);
  return event;
}

test('admin cancellation suppresses a notice when the Calendar phone belongs to another profile', async () => {
  const event = seedPatientAppointment();
  const admin = process.env.ADMIN_PHONE_NUMBER;
  process.env.WHATSAPP_CANCELLATION_TEMPLATE = 'cita_cancelada_clinica';
  patientNames.set(patient, 'Otro Paciente');
  const before = metaRequests.length;
  try {
    const details = await liveCalendar.getCalendarAppointment(event.id);
    await proposeAppointmentAction(admin, { action: 'cancel_clinic', details });
    assert.match(metaRequests.at(-1).interactive.body.text, /0002 sin verificar/);
    const buttons = lastButtons();
    assert.equal(buttons.some(id => id.startsWith('appointment_notify_')), false);
    const only = buttons.find(id => id.startsWith('appointment_only_'));
    await webhook([answerButton('legacy-cancel', only.replace('_only_', '_yes_'), admin)]);
    assert.equal(events.has(event.id), true);
    await webhook([answerButton('cancel-without-notice', only, admin)]);
    assert.equal(events.has(event.id), false);
    assert.match(metaRequests.at(-1).text.body, /sin enviar aviso/);
    assert.ok(metaRequests.slice(before).every(message => message.to === admin && message.type !== 'template'));
  } finally {
    delete process.env.WHATSAPP_CANCELLATION_TEMPLATE;
    patientNames.clear();
    pendingAppointmentActions.clear();
    events.clear();
  }
});

test('admin cancellation sends one notice to the displayed number when the patient still matches', async () => {
  const event = seedPatientAppointment();
  const admin = process.env.ADMIN_PHONE_NUMBER;
  process.env.WHATSAPP_CANCELLATION_TEMPLATE = 'cita_cancelada_clinica';
  const before = metaRequests.length;
  try {
    const details = await liveCalendar.getCalendarAppointment(event.id);
    await proposeAppointmentAction(admin, { action: 'cancel_clinic', details });
    const confirmation = metaRequests.at(-1).interactive.body.text;
    assert.match(confirmation, /WhatsApp del aviso •••• 0002/);
    assert.equal(confirmation.includes(patient), false);
    const notify = appointmentOptions().find(id => id.startsWith('appointment_notify_'));
    await webhook([answerButton('cancel-and-notify', notify, admin), answerButton('cancel-and-notify-again', notify, admin)]);
    assert.equal(events.has(event.id), false);
    const templates = metaRequests.slice(before).filter(message => message.type === 'template');
    assert.deepEqual(templates.map(message => [message.to, message.template.name]), [[patient, 'cita_cancelada_clinica']]);
  } finally {
    delete process.env.WHATSAPP_CANCELLATION_TEMPLATE;
    pendingAppointmentActions.clear();
    notices.clear();
    events.clear();
  }
});

test('admin cancellation checks the recipient again after the confirmation was offered', async () => {
  const event = seedPatientAppointment();
  const admin = process.env.ADMIN_PHONE_NUMBER;
  process.env.WHATSAPP_CANCELLATION_TEMPLATE = 'cita_cancelada_clinica';
  const before = metaRequests.length;
  try {
    const details = await liveCalendar.getCalendarAppointment(event.id);
    await proposeAppointmentAction(admin, { action: 'cancel_clinic', details });
    const notify = appointmentOptions().find(id => id.startsWith('appointment_notify_'));
    patientNames.set(patient, 'Otro Paciente');
    await webhook([answerButton('cancel-after-contact-changed', notify, admin)]);
    assert.equal(events.has(event.id), false);
    assert.match(metaRequests.at(-1).text.body, /El aviso no se envió/);
    assert.ok(metaRequests.slice(before).every(message => message.to === admin && message.type !== 'template'));
  } finally {
    delete process.env.WHATSAPP_CANCELLATION_TEMPLATE;
    patientNames.clear();
    pendingAppointmentActions.clear();
    events.clear();
  }
});

test('admin corrects the Calendar contact before cancelling and sends the notice only to the confirmed number', async () => {
  const event = seedPatientAppointment();
  event.description += `\nWhatsApp del paciente: +${patient}`;
  const admin = process.env.ADMIN_PHONE_NUMBER;
  const corrected = '522210000033';
  const before = metaRequests.length;
  process.env.WHATSAPP_CANCELLATION_TEMPLATE = 'cita_cancelada_clinica';
  patientNames.set(patient, 'Otro Paciente');
  try {
    const details = await liveCalendar.getCalendarAppointment(event.id);
    await proposeAppointmentAction(admin, { action: 'cancel_clinic', details });
    await webhook([answerButton('edit-cancel-phone', lastButtons().find(id => id.startsWith('appointment_contact_')), admin)]);
    const promptId = `mock_${metaRequests.length}`;
    const reply = (id, value) => ({ ...textMessage(id, value, admin), context: { id: promptId } });
    await webhook([reply('reception-phone', '+52 1 5500000001')]);
    assert.match(metaRequests.at(-1).text.body, /número de recepción/);
    await webhook([reply('valid-cancel-phone', '221 000 0033')]);
    assert.match(metaRequests.at(-1).interactive.body.text, new RegExp(corrected));
    assert.equal(events.get(event.id).extendedProperties.private.patientPhone, patient);
    assert.ok(metaRequests.slice(before).every(message => message.to === admin));
    const confirmation = lastButtons().find(id => id.startsWith('appointment_corrected_'));
    await webhook([answerButton('confirm-new-number', confirmation, admin), answerButton('repeat-quoted-confirmation', confirmation, admin)]);
    assert.equal(events.has(event.id), false);
    const update = calendarPatches.at(-1);
    assert.equal(update.eventId, event.id);
    assert.equal(update.requestBody.visibility, 'private');
    assert.equal(update.requestBody.description, `Motivo original\nWhatsApp del paciente: +${corrected}`);
    assert.equal(update.requestBody.extendedProperties.private.patientPhone, corrected);
    assert.equal(update.requestBody.extendedProperties.private.clinicMetadata, 'original');
    assert.deepEqual(metaRequests.slice(before).filter(message => message.type === 'template')
      .map(message => message.to), [corrected]);
  } finally {
    delete process.env.WHATSAPP_CANCELLATION_TEMPLATE;
    patientNames.clear();
    pendingAppointmentActions.clear();
    notices.clear();
    events.clear();
  }
});

test('admin can look up upcoming appointments using either WhatsApp format for Mexico', async () => {
  const event = seedPatientAppointment();
  event.extendedProperties.private.patientPhone = '5215500000002';
  try {
    const admin = process.env.ADMIN_PHONE_NUMBER;
    await webhook([textMessage('lookup-admin-citas', 'Buscar cita por WhatsApp 55 0000 0002', admin)]);
    const reply = metaRequests.at(-1);
    assert.equal(reply.to, admin);
    assert.match(reply.text.body, /WhatsApp •••• 0002/);
    assert.match(reply.text.body, /Ana Demo/);
    await webhook([textMessage('lookup-other-number', 'Buscar cita por WhatsApp +52 55 0000 0003', admin)]);
    assert.match(metaRequests.at(-1).text.body, /Sin citas futuras/);
  } finally {
    events.clear();
  }
});

test('admin can save a corrected WhatsApp on a verified appointment without cancelling or sending a notice', async () => {
  const event = seedPatientAppointment();
  event.extendedProperties.private.attendanceConfirmedFor = event.start.dateTime;
  const admin = process.env.ADMIN_PHONE_NUMBER;
  const newPhone = '522210000033';
  const before = metaRequests.length;
  const patches = calendarPatches.length;
  process.env.WHATSAPP_CANCELLATION_TEMPLATE = 'cita_cancelada_clinica';
  try {
    const details = await liveCalendar.getCalendarAppointment(event.id);
    await proposeAppointmentAction(admin, { action: 'cancel_clinic', details });
    const contact = appointmentOptions().find(id => id.startsWith('appointment_contact_'));
    await webhook([{
      id: 'open-contact-editor', from: admin, type: 'interactive',
      interactive: { list_reply: { id: contact } },
    }]);
    const promptId = `mock_${metaRequests.length}`;
    await webhook([{ ...textMessage('enter-new-phone', newPhone, admin), context: { id: promptId } }]);
    const [save, cancel] = ['save', 'corrected'].map(action =>
      lastButtons().find(id => id.startsWith(`appointment_${action}_`)));
    await webhook([answerButton('patient-cannot-save-phone', save)]);
    assert.equal(calendarPatches.length, patches);
    await webhook([answerButton('admin-save-only', save, admin)]);
    assert.match(metaRequests.at(-1).text.body, /WhatsApp actualizado en Calendar/);
    await webhook([answerButton('do-not-reuse-cancel-after-save', cancel, admin)]);
    const savedEvent = events.get(event.id);
    assert.equal(calendarPatches.length, patches + 1);
    assert.equal(savedEvent.id, event.id);
    assert.deepEqual(savedEvent.start, event.start);
    assert.deepEqual(savedEvent.end, event.end);
    assert.equal(savedEvent.visibility, 'private');
    assert.equal(savedEvent.description, `Motivo original\nWhatsApp del paciente: +${newPhone}`);
    assert.equal(savedEvent.extendedProperties.private.patientPhone, newPhone);
    assert.equal(savedEvent.extendedProperties.private.attendanceConfirmedFor, 'pending');
    assert.equal((await liveCalendar.getPatientAppointments(newPhone))[0].eventId, event.id);
    assert.equal((await liveCalendar.getPatientAppointments(patient)).length, 0);
    assert.equal(metaRequests.slice(before).some(payload => payload.type === 'template'), false);
  } finally {
    delete process.env.WHATSAPP_CANCELLATION_TEMPLATE;
    pendingAppointmentActions.clear();
    notices.clear();
    events.clear();
  }
});

test('a WhatsApp reminder reply confirms attendance for its owner and reception sees it', async () => {
  const event = seedPatientAppointment();
  const reminderId = 'test-reminder';
  reminderReplies.set(reminderId, { event_id: event.id, scheduled_start: event.start.dateTime });
  const patches = calendarPatches.length;
  const message = (id, phone = patient) => ({ ...textMessage(id, 'Confirmo', phone), context: { id: reminderId } });
  try {
    await webhook([message('attendance-other-owner', '525500000003')]);
    assert.equal(calendarPatches.length, patches);
    await webhook([message('attendance-on-reminder'), message('attendance-twice')]);
    assert.equal(calendarPatches.length, patches + 1);
    assert.match(metaRequests.at(-1).text.body, /Asistencia confirmada/);
    await webhook([answerButton('view-confirmed-roster', 'admin_agenda', process.env.ADMIN_PHONE_NUMBER)]);
    assert.match(metaRequests.at(-1).interactive.body.text, /Ana Demo · Asistencia confirmada/);
  } finally {
    reminderReplies.clear();
    events.clear();
  }
});

test('reception views tomorrow and records a visit once without changing the Calendar appointment', async () => {
  const event = seedPatientAppointment();
  const today = clinicDate();
  const start = Math.max(Date.parse(clinicDayRange(today)[0]), Date.now() - 3_600_000);
  event.start.dateTime = new Date(start).toISOString();
  event.end.dateTime = new Date(start + 2_700_000).toISOString();
  const admin = process.env.ADMIN_PHONE_NUMBER;
  const patches = calendarPatches.length;
  const requests = metaRequests.length;
  try {
    await webhook([answerButton('new-roster-today', 'admin_agenda', admin)]);
    assert.ok(lastButtons().includes('rec_tomorrow'));
    await webhook([answerButton('new-roster-tomorrow', 'rec_tomorrow', admin)]);
    assert.match(metaRequests.at(-1).interactive.body.text, new RegExp(nextDate(today)));
    await webhook([answerButton('new-roster-register', 'rec_visits_0', admin)]);
    const pick = metaRequests.at(-1).interactive.action.sections[0].rows[0].id;
    await webhook([answerButton('new-roster-select', pick, admin)]);
    const [arrived, noShow] = lastButtons();
    await webhook([answerButton('patient-cannot-mark-visit', arrived, patient)]);
    assert.equal(calendarPatches.length, patches);
    await webhook([answerButton('new-roster-arrived', arrived, admin)]);
    assert.match(metaRequests.at(-1).text.body, /Llegó/);
    await webhook([answerButton('new-roster-stale-no-show', noShow, admin)]);
    assert.equal(calendarPatches.length, patches + 1);
    const saved = events.get(event.id);
    assert.deepEqual(saved.start, event.start);
    assert.deepEqual(saved.end, event.end);
    assert.equal(saved.extendedProperties.private.clinicMetadata, 'original');
    assert.equal(saved.extendedProperties.private.visitStatus, 'arrived');
    await webhook([answerButton('reception-visit-on-roster', 'admin_agenda', admin)]);
    assert.match(metaRequests.at(-1).interactive.body.text, /Ana Demo · Llegó/);
    await webhook([answerButton('reopen-registered-visits', 'rec_visits_0', admin)]);
    const current = metaRequests.at(-1).interactive.action.sections[0].rows[0].id;
    await webhook([answerButton('reopen-visit-status', current, admin)]);
    await webhook([answerButton('record-no-show-after-review', lastButtons()[1], admin)]);
    assert.equal(events.get(event.id).extendedProperties.private.visitStatus, 'no_show');
    assert.ok(metaRequests.slice(requests).every(message => message.type !== 'template'));
  } finally {
    events.clear();
  }
});

test('rescheduling patches only the existing Calendar event and resets stale attendance', async () => {
  const event = seedPatientAppointment();
  event.extendedProperties.private.attendanceConfirmedFor = event.start.dateTime;
  const created = createdAppointments.length;
  const patches = calendarPatches.length;
  try {
    await webhook([textMessage('move-mis-citas', 'Mis citas')]);
    assert.ok(metaRequests.at(-1).interactive.body.text.includes('https://maps.app.goo.gl/15xyVp2bi89p6Lrs5?g_st=ac'));
    const oldMove = lastButtons().find(id => id.startsWith('appt_move_'));
    await webhook([answerButton('move-options', oldMove)]);
    await webhook([answerButton('pick-reschedule', lastButtons()[0])]);
    assert.match(metaRequests.at(-1).interactive.body.text, /Confirma el cambio de horario/);
    const confirm = lastButtons()[0];
    await Promise.all([webhook([answerButton('move-yes', confirm)]), webhook([answerButton('move-duplicate', confirm)])]);
    assert.equal(events.size, 1);
    assert.equal(createdAppointments.length, created);
    assert.equal(calendarPatches.length, patches + 1);
    assert.equal(calendarPatches.at(-1).eventId, event.id);
    const updated = events.get(event.id);
    assert.equal(updated.start.dateTime, '2099-11-20T23:00:00.000Z');
    assert.equal(updated.end.dateTime, '2099-11-21T00:00:00.000Z');
    assert.equal(updated.description, event.description);
    assert.equal(updated.visibility, 'private');
    assert.equal(updated.extendedProperties.private.clinicMetadata, 'original');
    assert.equal(updated.extendedProperties.private.attendanceConfirmedFor, 'pending');
    const reminderId = 'pre-move-reminder';
    reminderReplies.set(reminderId, { event_id: event.id, scheduled_start: event.start.dateTime });
    await webhook([{ ...textMessage('old-time-confirmation', 'Confirmo'), context: { id: reminderId } }]);
    assert.match(metaRequests.at(-1).text.body, /horario que cambió/);
    assert.equal(calendarPatches.length, patches + 1);
    await webhook([answerButton('view-pending-roster', 'admin_agenda', process.env.ADMIN_PHONE_NUMBER)]);
    assert.match(metaRequests.at(-1).interactive.body.text, /Ana Demo · Asistencia pendiente/);
  } finally {
    bookingDrafts.delete(patient);
    reminderReplies.clear();
    events.clear();
  }
});

test('if the new slot becomes busy, the existing appointment keeps its original time', async () => {
  const event = seedPatientAppointment();
  const patches = calendarPatches.length;
  try {
    await webhook([textMessage('busy-mis-citas', 'Mis citas')]);
    await webhook([answerButton('busy-move-options', lastButtons().find(id => id.startsWith('appt_move_')))]);
    await webhook([answerButton('busy-move-pick', lastButtons()[0])]);
    busyPeriods = [{ start: '2099-11-20T23:00:00Z', end: '2099-11-21T00:00:00Z' }];
    const before = metaRequests.length;
    await webhook([answerButton('busy-move-confirm', lastButtons()[0])]);
    assert.equal(calendarPatches.length, patches);
    assert.equal(events.get(event.id).start.dateTime, event.start.dateTime);
    assert.match(metaRequests[before].text.body, /conserva el horario original/);
  } finally {
    busyPeriods = [];
    bookingDrafts.delete(patient);
    events.clear();
  }
});

test('availability excludes patient appointments marked free and allows adjacent slots', async () => {
  const date = '2099-11-20';
  events.set('occupied', {
    start: { dateTime: `${date}T10:30:00-06:00` }, end: { dateTime: `${date}T11:15:00-06:00` },
    transparency: 'transparent', extendedProperties: { private: { patientPhone: patient } },
  });
  events.set('unrelated-free-event', {
    start: { dateTime: `${date}T12:15:00-06:00` }, end: { dateTime: `${date}T13:00:00-06:00` },
    transparency: 'transparent',
  });
  try {
    const { slots } = await liveCalendar.getAvailableSlots(date);
    const startsAt = time => slots.some(slot => Date.parse(slot.start) === Date.parse(`${date}T${time}:00-06:00`));
    assert.equal(startsAt('10:15'), false);
    assert.equal(startsAt('10:30'), false);
    assert.equal(startsAt('11:15'), true);
    assert.equal(startsAt('12:15'), true);
  } finally {
    events.clear();
  }
});

test('an accepted Calendar write does not confirm until the saved appointment is readable', async () => {
  const event = seedPatientAppointment();
  const startTime = '2099-11-20T23:00:00.000Z';
  const booking = { actionId: 'test-booking', patientName: 'Ana Demo', patientPhone: patient, startTime, reason: 'Consulta' };
  const original = await liveCalendar.getCalendarAppointment(event.id);
  try {
    persistCalendarWrites = false;
    await assert.rejects(liveCalendar.createCalendarAppointment(booking), /verificar la cita guardada/);
    await assert.rejects(liveCalendar.moveCalendarAppointment(original, patient, startTime), /verificar la cita guardada/);
    await assert.rejects(liveCalendar.confirmCalendarAttendance(original, patient), /verificar la cita guardada/);
    assert.equal(events.size, 1);
    assert.equal(events.get(event.id).start.dateTime, event.start.dateTime);
    persistCalendarWrites = true;
    assert.equal((await liveCalendar.createCalendarAppointment(booking)).start, startTime);
    assert.equal(events.get('testbooking').transparency, 'opaque');
    assert.match(events.get('testbooking').description, new RegExp(`WhatsApp del paciente: \\+${patient}$`));
  } finally {
    persistCalendarWrites = true;
    events.clear();
  }
});

test('a clinic echo, delivery status, or stale reply cannot reopen the menu', async () => {
  const count = metaRequests.length;
  const old = { ...textMessage('expired-event', 'Hola'), timestamp: String(Math.floor(Date.now() / 1000) - 90_000) };
  assert.equal((await webhook([
    textMessage('clinic-echo', 'Hola', '5215500000099'),
    old,
    answerButton('retired-button', 'obsolete_option'),
  ], true, '525500000099', [{ id: 'callback-only', status: 'delivered' }])).status, 200);
  assert.equal(metaRequests.length, count);
  await webhook([textMessage('explicit-menu', 'Menú')]);
  assert.doesNotMatch(metaRequests.at(-1).interactive.body.text, /Soy Benson/);
});

test('a time change invalidates the previous confirmation and creates only the selected appointment', async () => {
  const before = metaRequests.length;
  await webhook([answerButton('book-from-treatment', 'book_trt_3')]);
  assert.equal(lastButtons().length, 3);
  assert.match(metaRequests.at(-1).interactive.body.text, /16:00[\s\S]*17:00/);
  await webhook([answerButton('first-slot', lastButtons()[0])]);
  assert.match(metaRequests.at(-1).interactive.body.text, /Ana Demo/);
  await webhook([answerButton('first-name', lastButtons()[0])]);
  const oldConfirmation = lastButtons()[0];
  await webhook([textMessage('other-hour', '¿Hay a las 10?')]);
  assert.match(metaRequests.at(-1).interactive.body.text, /Ese horario no está disponible/);
  await webhook([answerButton('old-confirmation', oldConfirmation)]);
  assert.match(metaRequests.at(-1).text.body, /ya cambió o venció/);
  assert.equal(createdAppointments.length, 0);
  const draft = bookingDrafts.get(patient);
  await webhook([answerButton('second-slot', `booking_${draft.revision}_1`)]);
  await webhook([answerButton('second-name', lastButtons()[0])]);
  assert.match(metaRequests.at(-1).interactive.body.text, /Tratamiento de muestra número 3/);
  const confirm = lastButtons()[0];
  await Promise.all([webhook([answerButton('latest-confirmation', confirm)]), webhook([answerButton('repeat-confirmation', confirm)])]);
  assert.equal(createdAppointments.length, 1);
  assert.equal(createdAppointments[0].startTime, calendarSlots[1].start);
  assert.equal(createdAppointments[0].reason, treatments[2].name);
  const confirmed = metaRequests.slice(before).find(message => message.text?.body.includes('*Cita confirmada*'));
  assert.ok(confirmed.text.body.includes('https://maps.app.goo.gl/15xyVp2bi89p6Lrs5?g_st=ac'));
});

test('the admin books for the patient and confirms name, contact, and reason', async () => {
  const admin = process.env.ADMIN_PHONE_NUMBER;
  await webhook([answerButton('admin-book', 'admin_booking', admin)]);
  await webhook([answerButton('admin-slot', lastButtons()[0], admin)]);
  assert.match(metaRequests.at(-1).text.body, /nombre completo/);
  await webhook([textMessage('admin-name', 'Sofía Ramírez', admin)]);
  assert.match(metaRequests.at(-1).text.body, /WhatsApp del paciente/);
  await webhook([textMessage('admin-phone', '5512345678', admin)]);
  await webhook([textMessage('admin-reason', 'Valoración dental', admin)]);
  assert.match(metaRequests.at(-1).interactive.body.text, /Sofía Ramírez/);
  assert.match(metaRequests.at(-1).interactive.body.text, /Valoración dental/);
  const before = metaRequests.length;
  await webhook([answerButton('admin-confirm', lastButtons()[0], admin)]);
  assert.ok(metaRequests.slice(before).every(message => message.to === admin && !message.text?.body.includes('maps.app.goo.gl')));
  assert.equal(createdAppointments.at(-1).patientPhone, '525512345678');
  assert.equal(createdAppointments.at(-1).patientName, 'Sofía Ramírez');
});

test('the cron rejects missing or mismatched credentials', async () => {
  delete process.env.CRON_SECRET;
  const request = token => new Request('https://clinic.test/api/cron/reminders', { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await reminders(request('undefined'))).status, 401);
  process.env.CRON_SECRET = 'real-demo-secret';
  assert.equal((await reminders(request('fake-demo-secret'))).status, 401);
});

test('tomorrow spans the entire local day across a month boundary', () => {
  const day = nextDate('2026-11-30');
  assert.equal(day, '2026-12-01');
  assert.deepEqual(clinicDayRange(day), ['2026-12-01T06:00:00.000Z', '2026-12-02T06:00:00.000Z']);
});

test('hourly reminder runs have enough overlap for a missed run and a small delay', () => {
  const first = reminderWindow(new Date('2026-11-30T23:00:13Z'));
  const second = reminderWindow(new Date('2026-12-01T00:00:13Z'));
  assert.equal(first.start.toISOString(), '2026-12-01T20:55:13.000Z');
  assert.equal(first.end.toISOString(), '2026-12-01T23:00:13.000Z');
  assert.equal(second.start.toISOString(), '2026-12-01T21:55:13.000Z');
  assert.equal(second.end.toISOString(), '2026-12-02T00:00:13.000Z');
});

test('reminders remain disabled until configured and send once per appointment time', async () => {
  const event = { eventId: 'event-test', summary: 'Cita: Ana Demo', start: '2026-12-01T18:00:00Z', patientPhone: patient };
  const before = metaRequests.length;
  delete process.env.WHATSAPP_REMINDER_TEMPLATE;
  assert.equal(await sendAppointmentNotice(event, 'reminder'), 'not_configured');
  assert.equal(notices.size, 0);
  process.env.WHATSAPP_REMINDER_TEMPLATE = 'cita_recordatorio';
  assert.deepEqual(await Promise.all([sendAppointmentNotice(event, 'reminder'), sendAppointmentNotice(event, 'reminder')]),
    ['accepted', 'already_recorded']);
  assert.equal(metaRequests.length - before, 1);
  const message = metaRequests.at(-1);
  assert.equal(message.template.name, 'cita_recordatorio');
  assert.deepEqual(message.template.components[0].parameters.slice(0, 2).map(item => item.text), ['Ana Demo', 'J R Dental']);
});

test('an authenticated cron run sends an appointment template and never the welcome menu', async () => {
  process.env.CRON_SECRET = 'real-demo-secret';
  process.env.WHATSAPP_REMINDER_TEMPLATE = 'cita_recordatorio';
  const start = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
  upcomingAppointments = [{ eventId: 'cron-test', summary: 'Cita: Ana Demo', start, patientPhone: patient }];
  const count = metaRequests.length;
  try {
    const request = new Request('https://clinic.test/api/cron/reminders', { headers: { authorization: 'Bearer real-demo-secret' } });
    const result = await reminders(request);
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).counts, { accepted: 1 });
    assert.equal(metaRequests.length, count + 1);
    assert.equal(metaRequests.at(-1).template.name, 'cita_recordatorio');
    assert.equal(metaRequests.at(-1).type, 'template');
  } finally {
    upcomingAppointments = [];
  }
});

test('the admin can list open tasks and set a future reminder on an existing task', async () => {
  clinicTasks.clear();
  delete process.env.WHATSAPP_TASK_REMINDER_TEMPLATE;
  await addClinicTask({ description: 'Pedir guantes' });
  assert.match(await addClinicTask({ description: 'Sin hora', reminder_requested: true, date: '2099-11-20' }), /fecha y hora futuras/);
  assert.equal(clinicTasks.size, 1);
  assert.match(await scheduleClinicTask(1, '2099-11-20', '09:00'), /pendiente de activar/);
  assert.equal(clinicTasks.get(1).reminder_at, '2099-11-20T15:00:00.000Z');
  assert.match(await scheduleClinicTask(1, '2000-01-01', '09:00'), /fecha y hora futuras/);
  const admin = process.env.ADMIN_PHONE_NUMBER;
  await webhook([answerButton('pending-dashboard', 'admin_tasks_0', admin)]);
  assert.match(metaRequests.at(-1).interactive.body.text, /Pedir guantes[\s\S]*envío pendiente de activación/);
  await webhook([textMessage('pending-detail', 'Pendiente #1', admin)]);
  assert.match(metaRequests.at(-1).text.body, /Recuérdame el pendiente #1/);
  await webhook([textMessage('pending-complete', 'Completar #1', admin)]);
  assert.equal(clinicTasks.get(1).is_completed, true);
  await webhook([textMessage('pending-empty', 'Pendientes', admin)]);
  assert.match(metaRequests.at(-1).text.body, /No hay pendientes abiertos/);
});

test('concurrent cron runs send each due task just once and only to the administrator', async () => {
  clinicTasks.clear();
  process.env.CRON_SECRET = 'test-cron-secret';
  delete process.env.WHATSAPP_TASK_REMINDER_TEMPLATE;
  taskReminderTemplate = 'pendiente_clinica_recordatorio';
  const due = new Date(Date.now() - 5_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  clinicTasks.set(1, { id: 1, is_completed: false, reminder_state: 'scheduled', reminder_at: due, description: 'Detalle privado' });
  clinicTasks.set(2, { id: 2, is_completed: true, reminder_state: 'scheduled', reminder_at: due });
  clinicTasks.set(3, { id: 3, is_completed: false, reminder_state: 'scheduled', reminder_at: future });
  const before = metaRequests.length;
  try {
    const request = () => new Request('https://clinic.test/api/cron/reminders', { headers: { authorization: 'Bearer test-cron-secret' } });
    const responses = await Promise.all([reminders(request()), reminders(request())]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(metaRequests.length, before + 1);
    const message = metaRequests.at(-1);
    assert.equal(message.to, process.env.ADMIN_PHONE_NUMBER);
    assert.equal(message.template.name, taskReminderTemplate);
    assert.deepEqual(message.template.components[0].parameters.map(param => param.text), ['1']);
    assert.equal(clinicTasks.get(1).reminder_state, 'accepted');
    assert.equal(clinicTasks.get(2).reminder_state, 'scheduled');
    assert.equal(clinicTasks.get(3).reminder_state, 'scheduled');
    await webhook([], true, '525500000099', [{ id: clinicTasks.get(1).reminder_message_id, status: 'delivered' }]);
    assert.equal(clinicTasks.get(1).reminder_state, 'delivered');
  } finally {
    taskReminderTemplate = null;
  }
});

test('downloads the Meta attachment and forwards the OGG bytes to transcription', async () => {
  const previousFetch = globalThis.fetch;
  const sample = new Uint8Array([79, 103, 103, 83]);
  process.env.OPENAI_API_KEY = 'test-openai';
  globalThis.fetch = async (url, options) => {
    const address = new URL(url);
    if (address.hostname === 'graph.facebook.com') {
      assert.equal(address.searchParams.get('phone_number_id'), '12345678');
      return Response.json({ url: 'https://lookaside.fbsbx.com/demo', mime_type: 'audio/ogg; codecs=opus', file_size: sample.length });
    }
    if (address.hostname === 'lookaside.fbsbx.com') {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return new Response(sample);
    }
    assert.equal(address.href, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(options.body.get('model'), 'whisper-1');
    const audio = options.body.get('file');
    assert.equal(audio.name, 'voice-note.ogg');
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), sample);
    return Response.json({ text: ' Quiero agendar una cita. ' });
  };
  try {
    assert.equal(await transcribeWhatsAppAudio('123456'), 'Quiero agendar una cita.');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
