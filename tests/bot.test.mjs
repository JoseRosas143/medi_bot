import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const databaseUrl = 'data:text/javascript,export const supabaseAdmin=globalThis.testDatabase';
const googleUrl = 'data:text/javascript,export const google=globalThis.testGoogle';
const calendarUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const { getUpcomingSlots, getAvailableSlots, createCalendarAppointment, findCalendarBooking,
    cancelCalendarEvent, getPatientAppointments, getAppointmentsByDateRange, appointmentPatientName,
    getCalendarAppointment, moveCalendarAppointment, confirmCalendarAttendance, appointmentMatchesSlot } = globalThis.testCalendar;
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
const clinicTasks = new Map();
let taskReminderTemplate = null;
const createdAppointments = [];
let upcomingAppointments = [];
const events = new Map();
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
  getAppointmentsByDateRange: async (...args) => events.size ? liveCalendar.getAppointmentsByDateRange(...args) : upcomingAppointments,
  getCalendarAppointment: liveCalendar.getCalendarAppointment,
  appointmentMatchesSlot: liveCalendar.appointmentMatchesSlot,
  moveCalendarAppointment: liveCalendar.moveCalendarAppointment,
  confirmCalendarAttendance: liveCalendar.confirmCalendarAttendance,
  appointmentPatientName: summary => summary.replace(/^Cita: /, ''),
};
const treatments = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1, price: 100.5 + i, name: `Tratamiento de muestra número ${i + 1}`,
  description: 'Descripción informativa de la clínica.',
}));

function query(table) {
  let operation = 'select';
  let values;
  const filters = {};
  const constraints = [];
  let singleRow = false;
  let limit;
  let sort;
  let range;
  const chain = {
    select: () => chain,
    order: (field, options) => { sort = { field, ascending: options?.ascending !== false }; return chain; },
    maybeSingle: () => { singleRow = true; return chain; },
    single: () => { singleRow = true; return chain; },
    or: rule => {
      if (rule === 'reminder_state.is.null,reminder_state.neq.sending') constraints.push(row => row.reminder_state !== 'sending');
      return chain;
    },
    eq: (field, value) => { filters[field] = value; return chain; },
    in: (field, choices) => { constraints.push(row => choices.includes(row[field])); return chain; },
    lt: (field, value) => { constraints.push(row => row[field] != null && row[field] < value); return chain; },
    lte: (field, value) => { constraints.push(row => row[field] != null && row[field] <= value); return chain; },
    limit: value => { limit = value; return chain; },
    match: () => chain, gt: () => chain, delete: () => chain,
    insert: value => { operation = 'insert'; values = value; return chain; },
    upsert: value => { operation = 'upsert'; values = value; return chain; },
    update: value => { operation = 'update'; values = value; return chain; },
    range: (from, to) => { range = [from, to]; return chain; },
    throwOnError: () => chain,
    then: resolve => {
      if (table === 'bot_settings' && operation === 'select') {
        return resolve({ data: { task_reminder_template: taskReminderTemplate }, error: null });
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
      if (table === 'whatsapp_receipts' && operation === 'insert') {
        if (receipts.has(values.message_id)) return resolve({ error: { code: '23505' } });
        receipts.add(values.message_id);
      }
      if (table === 'appointment_notices' && operation === 'insert') {
        const key = JSON.stringify(values);
        if (notices.has(key)) return resolve({ error: { code: '23505' } });
        notices.add(key);
      }
      if (table === 'appointment_notices' && operation === 'select') {
        return resolve({ data: reminderReplies.get(filters.wa_message_id) || null, error: null });
      }
      if (table === 'patients' && operation === 'select') {
        return resolve({ data: { phone: filters.phone, full_name: 'Ana Demo', chat_mode: 'AI_ACTIVE', human_session_id: null } });
      }
      if (table === 'chat_messages' && operation === 'insert') saved.push(values);
      if (table === 'treatments' && range) return resolve({ data: treatments.slice(range[0], range[1] + 1) });
      if (table === 'treatments' && filters.id) return resolve({ data: treatments.find(item => item.id === filters.id) });
      return resolve({ data: null, error: null });
    },
  };
  return chain;
}
globalThis.testDatabase = { from: query };
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/graph\.facebook\.com\//);
  metaRequests.push(JSON.parse(options.body));
  return Response.json({ messages: [{ id: `mock_${metaRequests.length}` }] });
};

const { POST: whatsapp } = await import('../src/app/api/webhook/whatsapp/route.ts');
const { GET: reminders } = await import('../src/app/api/cron/reminders/route.ts');
const { clinicDayRange, nextDate, reminderWindow } = await import('../src/lib/clinic-time.ts');
const { showCatalog, showAdminMenu } = await import('../src/lib/menus.ts');
const { sendAppointmentNotice } = await import('../src/lib/appointment-notices.ts');
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
  return metaRequests.at(-1).interactive.action.buttons.map(button => button.reply.id);
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
    assert.match(metaRequests.at(-1).text.body, /Ana Demo · Asistencia confirmada/);
  } finally {
    reminderReplies.clear();
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
    assert.match(metaRequests.at(-1).text.body, /Ana Demo · Asistencia pendiente/);
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
  await webhook([answerButton('admin-confirm', lastButtons()[0], admin)]);
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
