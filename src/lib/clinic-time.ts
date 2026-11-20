export const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || 'America/Mexico_City';
export const clinicName = () => process.env.CLINIC_NAME || 'J R Dental';

export function clinicDate(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: CLINIC_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

export function nextDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function clinicInstant(date: string, time: string): Date {
  const local = `${date}T${time}:00`;
  const target = Date.parse(`${local}Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 19) !== local) {
    throw new Error('Fecha u hora inválida');
  }
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: CLINIC_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const values = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type, part.value]));
    const actual = `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
    if (local === actual) return new Date(candidate);
    candidate += target - Date.parse(`${actual}Z`);
  }
  throw new Error('La hora solicitada no existe en la zona horaria de la clínica');
}

export function clinicDayRange(date: string): [string, string] {
  return [clinicInstant(date, '00:00').toISOString(), clinicInstant(nextDate(date), '00:00').toISOString()];
}

export function reminderWindow(now: Date = new Date()) {
  const minute = 60 * 1000;
  // Allow one missed hourly run and a few minutes of variation in its start time.
  return {
    start: new Date(now.getTime() + (22 * 60 - 5) * minute),
    end: new Date(now.getTime() + 24 * 60 * minute),
  };
}

export function formatAppointment(start: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: CLINIC_TIMEZONE, dateStyle: 'full', timeStyle: 'short',
  }).format(new Date(start));
}
