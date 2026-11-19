import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAppointmentsByDateRange } from '@/lib/calendar';
import { clinicDate, clinicDayRange, nextDate } from '@/lib/clinic-time';
import { sendAppointmentNotice } from '@/lib/appointment-notices';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const token = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || token.length !== expected.length || !timingSafeEqual(token, expected)) {
    return new NextResponse('No autorizado', { status: 401 });
  }

  try {
    const date = nextDate(clinicDate());
    const [start, end] = clinicDayRange(date);
    const appointments = (await getAppointmentsByDateRange(start, end))
      .filter(event => Date.parse(event.start) >= Date.parse(start) && Date.parse(event.start) < Date.parse(end));
    const counts: Record<string, number> = {};
    for (let index = 0; index < appointments.length; index += 5) {
      const results = await Promise.allSettled(appointments.slice(index, index + 5).map(event => sendAppointmentNotice(event, 'reminder')));
      for (const result of results) {
        const state = result.status === 'fulfilled' ? result.value : 'error';
        counts[state] = (counts[state] ?? 0) + 1;
      }
    }
    const success = !counts.rejected && !counts.uncertain && !counts.error && !counts.not_configured;
    return NextResponse.json({ success, date, counts }, { status: success ? 200 : 502 });
  } catch {
    console.error('Reminder run failed before processing notices');
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
