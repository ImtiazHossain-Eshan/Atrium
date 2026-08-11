/**
 * Fixtures for the tests that need a database.
 *
 * These run against the same database the application uses, so everything they
 * create is tagged and removed again in `cleanup()`. Nothing here touches the
 * seeded historical rows.
 *
 * If the database is not reachable the suites that use this skip rather than
 * fail, so `npm test` still reports something useful on a machine where only
 * the pure logic can be exercised.
 */
import { it } from 'node:test';
import { pool, query } from '../src/db';
import { hashPassword } from '../src/auth';
import { CENTRE_TIMEZONE, centreInstant } from '../src/domain';

export const TAG = 'atrium-test';

let reachable: boolean | null = null;

export async function databaseAvailable(): Promise<boolean> {
  if (reachable === null) {
    try {
      await query('select 1');
      reachable = true;
    } catch {
      reachable = false;
    }
  }
  return reachable;
}

/**
 * `it` for a test that needs the database. Skips rather than fails when there
 * is no database to talk to, so `npm test` still reports the pure logic on a
 * machine where PostgreSQL is not set up.
 */
export function dbIt(name: string, fn: () => Promise<void>): void {
  it(name, async (t) => {
    if (!(await databaseAvailable())) {
      t.skip('no database reachable: set DATABASE_URL and run npm run migrate');
      return;
    }
    await fn();
  });
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CENTRE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short'
});

/**
 * A centre-local slot far enough ahead to clear the coach's 48-hour deadline,
 * skipping forward past Sundays because the centre is closed.
 */
export function slotAt(daysFromNow: number, time: string): { startsAt: string; endsAtAfter: (minutes: number) => string } {
  let offset = daysFromNow;
  let parts = describeDay(offset);
  while (parts.weekday === 'Sun') {
    offset += 1;
    parts = describeDay(offset);
  }
  const startsAt = centreInstant(parts.date, time);
  return {
    startsAt,
    endsAtAfter: (minutes: number) => new Date(new Date(startsAt).getTime() + minutes * 60000).toISOString()
  };
}

function describeDay(daysFromNow: number) {
  const target = new Date(Date.now() + daysFromNow * 86400000);
  const parts = dayFormatter.formatToParts(target);
  const get = (name: string) => parts.find((part) => part.type === name)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday') };
}

let sequence = 0;
const uniqueEmail = (role: string) => `${TAG}-${role}-${process.pid}-${++sequence}@example.invalid`;

export async function makePerson(kind: 'admin' | 'coach' | 'participant', credits: number, password?: string) {
  const email = uniqueEmail(kind);
  const rows = await query<any>(
    `insert into person (email, password_hash, full_name, kind, credits, active, created_at)
     values ($1, $2, $3, $4, $5, true, now())
     returning id, email, full_name, kind, credits`,
    [email, password ? hashPassword(password) : null, `${TAG} ${kind}`, kind, credits]
  );
  return { ...rows[0], password };
}

export async function makeRoom(capacity: number) {
  const rows = await query<any>(
    'insert into room (name, capacity) values ($1, $2) returning id, name, capacity',
    [`${TAG} room ${process.pid}-${++sequence}`, capacity]
  );
  return rows[0];
}

export async function makeSession(options: {
  roomId: number;
  coachId: number;
  startsAt: string;
  endsAt: string;
  sessionType?: string;
  seatFee?: number;
  roomFee?: number;
  discipline?: string;
  status?: string;
}) {
  const rows = await query<any>(
    `insert into session (room_id, coach_id, discipline, session_type, status, starts_at, ends_at, room_fee_credits, seat_fee_credits, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) returning *`,
    [
      options.roomId,
      options.coachId,
      options.discipline ?? `${TAG} discipline`,
      options.sessionType ?? 'standard',
      options.status ?? 'scheduled',
      options.startsAt,
      options.endsAt,
      options.roomFee ?? 40,
      options.seatFee ?? 20
    ]
  );
  return rows[0];
}

export async function creditsOf(personId: number): Promise<number> {
  const rows = await query<{ credits: number }>('select credits from person where id = $1', [personId]);
  return Number(rows[0].credits);
}

/**
 * Removes every row these tests created, children first.
 *
 * This deletes by tag rather than by process, so the database-backed test files
 * run one at a time (`--test-concurrency=1` in package.json). Running them
 * concurrently would have each suite's setup wipe the other's fixtures.
 */
export async function cleanup(): Promise<void> {
  const people = `(select id from person where email like '${TAG}-%')`;
  const rooms = `(select id from room where name like '${TAG} room%')`;
  const sessions = `(select id from session where coach_id in ${people} or room_id in ${rooms})`;

  await query(`delete from check_in where enrolment_id in (select id from enrolment where person_id in ${people} or session_id in ${sessions})`);
  await query(`delete from enrolment where person_id in ${people} or session_id in ${sessions}`);
  await query(`delete from credit_ledger where person_id in ${people}`);
  await query(`delete from app_session where person_id in ${people}`);
  await query(`delete from password_reset_token where person_id in ${people}`);
  await query(`delete from session where coach_id in ${people} or room_id in ${rooms}`);
  await query(`delete from person where email like '${TAG}-%'`);
  await query(`delete from room where name like '${TAG} room%'`);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
