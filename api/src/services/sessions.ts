import { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { Role } from '../auth';
import { hoursOfNotice, refundAmount, refundPercent, roomFee, seatFee } from '../credits';
import { centreDateTime, validateSessionWindow } from '../domain';
import { notifyAdmins, notifySessionCancelled, notifySessionChanged } from '../notifications';
import {
  findConflictedAttendees,
  findPersonConflict,
  findRoomConflict,
  violatesCoachNotice
} from './conflicts';

export type Actor = { id: number; kind: Role };

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

/**
 * Sessions are created, moved and cancelled here and nowhere else.
 *
 * The route layer and the assistant both used to carry their own copy of this
 * logic, which is how they came to disagree about what a cancellation does.
 * There is one implementation now; the callers differ only in how they report
 * the result.
 */

function assertMayActOn(session: { coach_id: number }, actor: Actor): void {
  if (actor.kind === 'admin') return;
  if (actor.kind === 'coach' && session.coach_id === actor.id) return;
  throw new DomainError('forbidden', 'you can only manage your own sessions', 403);
}

async function lockSession(client: PoolClient, sessionId: number) {
  const rows = await client.query('select * from session where id = $1 for update', [sessionId]);
  if (!rows.rowCount) throw new DomainError('not_found', 'no such session', 404);
  return rows.rows[0];
}

export type CreateSessionInput = {
  roomId: number;
  coachId: number;
  discipline: string;
  sessionType: string;
  startsAt: string;
  endsAt: string;
};

export async function createSession(actor: Actor, input: CreateSessionInput) {
  const windowError = validateSessionWindow(input.sessionType, input.startsAt, input.endsAt);
  if (windowError) throw new DomainError('invalid_window', windowError);

  // An administrator schedules on behalf of the centre and is not bound by the
  // coach's own booking deadline; a coach always is. See README, assumptions.
  if (actor.kind === 'coach' && violatesCoachNotice(input.startsAt)) {
    throw new DomainError('notice_too_short', 'coaches must book a room at least 48 hours before the session starts');
  }

  const created = await withTransaction(async (client) => {
    // Ordered lock acquisition: room first, then person. Every write path takes
    // these in the same order, so two concurrent bookings cannot deadlock.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`room:${input.roomId}`]);
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`person:${input.coachId}`]);

    const room = await client.query('select id, name, capacity from room where id = $1', [input.roomId]);
    if (!room.rowCount) throw new DomainError('room_not_found', 'that room does not exist');

    const coach = await client.query('select id, kind, active from person where id = $1', [input.coachId]);
    if (!coach.rowCount || coach.rows[0].kind !== 'coach' || !coach.rows[0].active) {
      throw new DomainError('coach_not_found', 'choose an active coach');
    }

    if (await findRoomConflict(client, input.roomId, input.startsAt, input.endsAt)) {
      throw new DomainError('room_conflict', 'that room is already booked for this interval', 409);
    }
    if (await findPersonConflict(client, input.coachId, input.startsAt, input.endsAt)) {
      throw new DomainError('person_conflict', 'the coach already has an overlapping commitment', 409);
    }

    const fee = roomFee(input.sessionType);
    const inserted = await client.query(
      `insert into session (room_id, coach_id, discipline, session_type, status, starts_at, ends_at, room_fee_credits, seat_fee_credits)
       values ($1, $2, $3, $4, 'scheduled', $5, $6, $7, $8) returning *`,
      [input.roomId, input.coachId, input.discipline, input.sessionType, input.startsAt, input.endsAt, fee, seatFee(input.sessionType)]
    );

    // Conditional debit: the balance guard is part of the UPDATE rather than a
    // preceding SELECT, so a concurrent booking cannot spend the same credits.
    const debit = await client.query(
      'update person set credits = credits - $1 where id = $2 and credits >= $1 returning credits',
      [fee, input.coachId]
    );
    if (!debit.rowCount) throw new DomainError('insufficient_credits', 'the coach does not have enough credits');

    await client.query(
      'insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, $3, $4)',
      [input.coachId, -fee, 'room booking', inserted.rows[0].id]
    );
    return inserted.rows[0];
  });

  void notifyAdmins(
    'New room booking',
    `${created.discipline} was booked into a room for ${centreDateTime(created.starts_at)}.`
  ).catch(console.error);

  return created;
}

export async function cancelSession(sessionId: number, actor: Actor) {
  const summary = await withTransaction(async (client) => {
    const session = await lockSession(client, sessionId);
    assertMayActOn(session, actor);
    if (session.status === 'cancelled') throw new DomainError('already_cancelled', 'that session is already cancelled', 409);

    const coachPercent = refundPercent(hoursOfNotice(new Date(), new Date(session.starts_at)));
    const coachRefund = refundAmount(Number(session.room_fee_credits), coachPercent);

    const enrolments = await client.query(
      `select id, person_id, credits_charged from enrolment
        where session_id = $1 and status = 'active' for update`,
      [sessionId]
    );

    // The participant did nothing wrong, so the notice tiers do not apply to
    // them: a coach cancellation returns the place fee in full.
    let participantRefund = 0;
    const affected: number[] = [];
    for (const enrolment of enrolments.rows) {
      const refund = Number(enrolment.credits_charged);
      participantRefund += refund;
      affected.push(enrolment.person_id);
      await client.query(
        `update enrolment set status = 'cancelled', credits_refunded = $1, cancelled_at = now() where id = $2`,
        [refund, enrolment.id]
      );
      if (refund > 0) {
        await client.query('update person set credits = credits + $1 where id = $2', [refund, enrolment.person_id]);
        await client.query(
          `insert into credit_ledger (person_id, amount, reason, reference_id)
           values ($1, $2, 'coach cancelled session', $3)`,
          [enrolment.person_id, refund, sessionId]
        );
      }
    }

    if (coachRefund > 0) {
      await client.query('update person set credits = credits + $1 where id = $2', [coachRefund, session.coach_id]);
      await client.query(
        `insert into credit_ledger (person_id, amount, reason, reference_id)
         values ($1, $2, 'room cancellation refund', $3)`,
        [session.coach_id, coachRefund, sessionId]
      );
    }

    await client.query("update session set status = 'cancelled' where id = $1", [sessionId]);
    return {
      coachRefund,
      refundPercent: coachPercent,
      participantRefund,
      affected: affected.length,
      affectedPeople: affected,
      startsAt: session.starts_at,
      discipline: session.discipline
    };
  });

  void notifySessionCancelled(sessionId, summary.affectedPeople).catch(console.error);
  void notifyAdmins(
    'Session cancelled',
    `${summary.discipline} on ${centreDateTime(summary.startsAt)} was cancelled. ` +
      `${summary.affected} participant(s) were refunded ${summary.participantRefund} credits in full; ` +
      `the coach received ${summary.coachRefund} credits back at ${Math.round(summary.refundPercent * 100)}% notice.`
  ).catch(console.error);

  return summary;
}

export async function rescheduleSession(
  sessionId: number,
  actor: Actor,
  startsAt: string,
  endsAt: string,
  discipline?: string
) {
  const updated = await withTransaction(async (client) => {
    const session = await lockSession(client, sessionId);
    assertMayActOn(session, actor);
    if (session.status === 'cancelled') throw new DomainError('already_cancelled', 'that session is cancelled', 409);

    const windowError = validateSessionWindow(session.session_type, startsAt, endsAt);
    if (windowError) throw new DomainError('invalid_window', windowError);

    if (actor.kind === 'coach' && violatesCoachNotice(startsAt)) {
      throw new DomainError('notice_too_short', 'a session cannot be moved to less than 48 hours from now');
    }

    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`room:${session.room_id}`]);
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`person:${session.coach_id}`]);

    if (await findRoomConflict(client, session.room_id, startsAt, endsAt, sessionId)) {
      throw new DomainError('room_conflict', 'that room is already booked at the new time', 409);
    }
    if (await findPersonConflict(client, session.coach_id, startsAt, endsAt, sessionId)) {
      throw new DomainError('person_conflict', 'the coach already has another commitment at the new time', 409);
    }

    // A move takes its attendees with it, so the new interval has to be free
    // for them too. Refusing is the right answer rather than silently dropping
    // someone from a session they paid for: the coach can cancel instead, which
    // refunds them in full.
    const conflicted = await findConflictedAttendees(client, sessionId, startsAt, endsAt);
    if (conflicted.length) {
      throw new DomainError(
        'attendee_conflict',
        `${conflicted.length} enrolled participant(s) already have another commitment at the new time: ` +
          `${conflicted.map((person) => person.full_name).join(', ')}. Cancel the session instead, or choose another time.`,
        409
      );
    }

    const result = await client.query(
      `update session set starts_at = $1, ends_at = $2, discipline = $3 where id = $4 returning *`,
      [startsAt, endsAt, (discipline ?? session.discipline).trim() || session.discipline, sessionId]
    );
    return result.rows[0];
  });

  void notifySessionChanged(sessionId).catch(console.error);
  return updated;
}

/**
 * Closes out sessions whose end time has passed. Run nightly by the scheduler.
 * Without it the seeded 'completed' status is never reached and finished
 * sessions keep advertising themselves as scheduled.
 */
export async function completeFinishedSessions(now = new Date()): Promise<number> {
  const rows = await query<{ id: number }>(
    "update session set status = 'completed' where status = 'scheduled' and ends_at < $1 returning id",
    [now]
  );
  return rows.length;
}
