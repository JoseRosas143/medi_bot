import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAppointmentsByDateRange } from '@/lib/calendar';
import { reminderWindow } from '@/lib/clinic-time';
import { sendAppointmentNotice } from '@/lib/appointment-notices';
import { runClinicTaskReminders } from '@/lib/clinic-tasks';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const token = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || token.length !== expected.length || !timingSafeEqual(token, expected)) {
    return new NextResponse('No autorizado', { status: 401 });
  }

  const [appointments, tasks] = await Promise.allSettled([
    runAppointmentReminders(), runClinicTaskReminders(),
  ]);
  const taskReminders = tasks.status === 'fulfilled' ? tasks.value : { enabled: true, counts: { error: 1 } };
  if (appointments.status === 'rejected' || tasks.status === 'rejected') {
    console.error('Reminder run failed', { appointments: appointments.status, tasks: tasks.status });
  }
  if (appointments.status === 'rejected') {
    return NextResponse.json({ success: false, task_reminders: taskReminders }, { status: 500 });
  }
  const { counts } = appointments.value;
  const taskCounts: Record<string, number> = taskReminders.counts;
  const success = !counts.rejected && !counts.uncertain && !counts.error && !counts.not_configured
    && !taskCounts.rejected && !taskCounts.uncertain && !taskCounts.error;
  return NextResponse.json({
    success, ...appointments.value, task_reminders: taskReminders,
  }, { status: success ? 200 : 502 });
}

async function runAppointmentReminders() {
  const { start, end } = reminderWindow();
  // Calendar's timeMax excludes matching start times and ignores milliseconds.
  const queryEnd = new Date(end.getTime() + 1000);
  const appointments = (await getAppointmentsByDateRange(start.toISOString(), queryEnd.toISOString()))
    .filter(event => {
      const beginsAt = Date.parse(event.start);
      return beginsAt >= start.getTime() && beginsAt <= end.getTime();
    });
  const counts: Record<string, number> = {};
  for (let index = 0; index < appointments.length; index += 5) {
    const results = await Promise.allSettled(appointments.slice(index, index + 5).map(event => sendAppointmentNotice(event, 'reminder')));
    for (const result of results) {
      const state = result.status === 'fulfilled' ? result.value : 'error';
      counts[state] = (counts[state] ?? 0) + 1;
    }
  }
  return { window_start: start.toISOString(), window_end: end.toISOString(), counts };
}
