import { SESSION_TYPES, sessionDurationMinutes } from './credits';

export const CENTRE_TIMEZONE = process.env.CENTRE_TIMEZONE || 'America/New_York';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRE_TIMEZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

export function centreDateParts(value: Date): { weekday: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return { weekday: parts.weekday, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

export function isOpenWindow(startsAt: Date, endsAt: Date): boolean {
  const start = centreDateParts(startsAt);
  const end = centreDateParts(endsAt);
  if (start.weekday === 'Sun' || end.weekday === 'Sun') return false;
  return start.hour * 60 + start.minute >= 7 * 60 && end.hour * 60 + end.minute <= 21 * 60;
}

export function validateSessionWindow(sessionType: string, startsAtValue: string, endsAtValue: string): string | null {
  if (!SESSION_TYPES.includes(sessionType as (typeof SESSION_TYPES)[number])) return 'choose a valid session type';
  const startsAt = new Date(startsAtValue);
  const endsAt = new Date(endsAtValue);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return 'enter valid start and end times';
  const expected = sessionDurationMinutes(sessionType) * 60 * 1000;
  if (endsAt.getTime() - startsAt.getTime() !== expected) {
    return `${sessionType} sessions must hold the room for ${sessionDurationMinutes(sessionType)} minutes`;
  }
  if (!isOpenWindow(startsAt, endsAt)) return 'sessions must run Monday to Saturday, between 07:00 and 21:00 centre time';
  return null;
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function localDayBounds(day: string): { from: Date; to: Date } {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) throw new Error('invalid local date');
  const from = new Date(Date.UTC(year, month - 1, date, 5, 0, 0));
  const to = new Date(from.getTime() + 26 * 60 * 60 * 1000);
  return { from, to };
}
