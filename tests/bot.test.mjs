import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const databaseUrl = 'data:text/javascript,export const supabaseAdmin=globalThis.testDatabase';
const calendarUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const { getUpcomingSlots, getAvailableSlots, createCalendarAppointment, findCalendarBooking,
    cancelCalendarEvent, getPatientAppointments, getAppointmentsByDateRange, appointmentPatientName } = globalThis.testCalendar;
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/supabase') return { shortCircuit: true, url: databaseUrl };
    if (specifier === '@/lib/calendar') return { shortCircuit: true, url: calendarUrl };
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
const saved = [];
const bookingDrafts = new Map();
const createdAppointments = [];
let upcomingAppointments = [];
const calendarSlots = ['16:00', '17:00', '18:00'].map(hour => ({
  start: `2099-11-20T${hour}:00-06:00`,
  end: `2099-11-20T${hour.replace(':00', ':45')}:00-06:00`,
  label: `Viernes a las ${hour}`,
}));
globalThis.testCalendar = {
  getUpcomingSlots: async () => calendarSlots,
  getAvailableSlots: async date => ({ date, slots: calendarSlots }),
  createCalendarAppointment: async params => {
    createdAppointments.push(params);
    return calendarSlots.find(slot => slot.start === params.startTime);
  },
  getPatientAppointments: async () => [],
  getAppointmentsByDateRange: async () => upcomingAppointments,
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
  let range;
  const chain = {
    select: () => chain, order: () => chain, maybeSingle: () => chain, single: () => chain, or: () => chain,
    eq: (field, value) => { filters[field] = value; return chain; },
    in: () => chain, match: () => chain, gt: () => chain, delete: () => chain,
    insert: value => { operation = 'insert'; values = value; return chain; },
    upsert: value => { operation = 'upsert'; values = value; return chain; },
    update: value => { operation = 'update'; values = value; return chain; },
    range: (from, to) => { range = [from, to]; return chain; },
    throwOnError: () => chain,
    then: resolve => {
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
