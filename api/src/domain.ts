import { SESSION_TYPES, sessionDurationMinutes } from './credits';

export const CENTRE_TIMEZONE = process.env.CENTRE_TIMEZONE || 'America/New_York';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRE_TIMEZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CENTRE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CENTRE_TIMEZONE,
  timeZoneName: 'shortOffset'
});

const stampFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: CENTRE_TIMEZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short'
});

const clockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: CENTRE_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

export function centreDateParts(value: Date): { weekday: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return { weekday: parts.weekday, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/**
 * Every time shown to a human (email, digest, log line) goes through here.
 * `toLocaleString()` renders in whatever zone the server happens to run in,
 * which is not the zone the centre operates in and not the zone the reader
 * cares about.
 */
export function centreDateTime(value: Date | string): string {
  return stampFormatter.format(new Date(value));
}

export function centreClock(value: Date | string): string {
  return clockFormatter.format(new Date(value));
}

export function centreDateString(value: Date): string {
  const parts = Object.fromEntries(
    dayFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function offsetMilliseconds(value: Date): number {
  const name = offsetFormatter.formatToParts(value).find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return (match[1] === '-' ? -1 : 1) * minutes * 60 * 1000;
}

/**
 * The instant at which a given centre-local calendar day begins.
 *
 * The offset is resolved twice because the first lookup is made against the
 * wrong instant: to know the offset you need the instant, and to know the
 * instant you need the offset. One correction is enough for every real zone,
 * because offsets never move by more than the gap between the two guesses.
 */
export function centreMidnight(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) throw new Error('invalid centre-local date');
  const naive = new Date(Date.UTC(year, month - 1, date));
  const firstGuess = new Date(naive.getTime() - offsetMilliseconds(naive));
  return new Date(naive.getTime() - offsetMilliseconds(firstGuess));
}

/**
 * The half-open interval covering one centre-local day.
 *
 * The end is the *next* local midnight rather than the start plus 24 hours. On
 * 1 November 2026 that interval is 25 hours long and on 8 March 2027 it is 23;
 * adding a fixed day would under-report the first and over-report the second.
 * 36 hours is used to step into the following day because it clears both the
 * longest day and the largest transition without landing back on the same one.
 */
/**
 * Turns a centre-local wall-clock date and time into the instant it names.
 * "2026-11-01 14:00 in New York" is a different instant before and after the
 * transition that morning, so the offset is resolved for that date rather than
 * assumed.
 */
export function centreInstant(day: string, time: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (!year || !month || !date || Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error('invalid centre-local date or time');
  }
  const naive = new Date(Date.UTC(year, month - 1, date, hour, minute));
  const firstGuess = new Date(naive.getTime() - offsetMilliseconds(naive));
  return new Date(naive.getTime() - offsetMilliseconds(firstGuess)).toISOString();
}

export function centreDayWindow(value = new Date()): { date: string; from: Date; to: Date } {
  const date = centreDateString(value);
  const from = centreMidnight(date);
  const nextDay = centreDateString(new Date(from.getTime() + 36 * 60 * 60 * 1000));
  return { date, from, to: centreMidnight(nextDay) };
}

export function isOpenWindow(startsAt: Date, endsAt: Date): boolean {
  const start = centreDateParts(startsAt);
  const end = centreDateParts(endsAt);
  if (start.weekday === 'Sun' || end.weekday === 'Sun') return false;
  if (centreDateString(startsAt) !== centreDateString(endsAt)) return false;
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
