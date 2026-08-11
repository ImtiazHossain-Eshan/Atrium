import { query, withTransaction } from '../db';
import { hoursOfNotice, refundAmount, refundPercent } from '../credits';
import { DomainError } from './sessions';
import { findPersonConflict } from './conflicts';

/**
 * Places are taken and released here and nowhere else, so the API and the
 * assistant cannot drift apart on what a booking costs or refunds.
 */

export async function bookSessionForPerson(personId: number, sessionId: number) {
  return withTransaction(async (client) => {
    // Serialise everything this person does. Two simultaneous requests from the
    // same account cannot both pass the overlap check and both take a place.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`person:${personId}`]);

    const sessions = await client.query(
      'select s.*, r.capacity from session s join room r on r.id = s.room_id where s.id = $1 for update',
      [sessionId]
    );
    if (!sessions.rowCount || sessions.rows[0].status === 'cancelled') {
      throw new DomainError('not_found', 'that session is no longer available', 404);
    }
    const session = sessions.rows[0];

    if (session.coach_id === personId) {
      throw new DomainError('own_session', 'a coach cannot book their own session', 409);
    }
    if (new Date(session.starts_at).getTime() <= Date.now()) {
      throw new DomainError('past_session', 'that session has already started', 400);
    }

    const existing = await client.query(
      'select id, status from enrolment where session_id = $1 and person_id = $2 for update',
      [sessionId, personId]
    );
    if (existing.rows.some((row: any) => row.status === 'active')) {
      throw new DomainError('already_booked', 'you already have an active booking for this session', 409);
    }

    // Capacity counts participants and excludes the coach, so this is a plain
    // count of active enrolments against the room.
    const count = await client.query(
      "select count(*)::int as count from enrolment where session_id = $1 and status = 'active'",
      [sessionId]
    );
    if (Number(count.rows[0].count) >= Number(session.capacity)) {
      throw new DomainError('full', 'that session is full', 409);
    }

    if (await findPersonConflict(client, personId, session.starts_at, session.ends_at)) {
      throw new DomainError('person_conflict', 'you already have another overlapping commitment', 409);
    }

    const charge = Number(session.seat_fee_credits);
    const debit = await client.query(
      'update person set credits = credits - $1 where id = $2 and credits >= $1 returning credits',
      [charge, personId]
    );
    if (!debit.rowCount) {
      throw new DomainError('insufficient_credits', 'there are not enough credits on the account for this place', 400);
    }

    const inserted = await client.query(
      `insert into enrolment (session_id, person_id, status, credits_charged, credits_refunded, enrolled_at)
       values ($1, $2, 'active', $3, 0, now()) returning *`,
      [sessionId, personId, charge]
    );
    await client.query(
      "insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'session booking', $3)",
      [personId, -charge, sessionId]
    );
    return inserted.rows[0];
  });
}

export async function cancelBookingForPerson(personId: number, sessionId: number) {
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`person:${personId}`]);

    const rows = await client.query(
      `select e.*, s.starts_at, s.status as session_status
         from enrolment e join session s on s.id = e.session_id
        where e.session_id = $1 and e.person_id = $2 and e.status = 'active' for update`,
      [sessionId, personId]
    );
    if (!rows.rowCount) throw new DomainError('not_found', 'no active booking found for that session', 404);

    const booking = rows.rows[0];
    if (booking.session_status === 'cancelled') {
      throw new DomainError('session_cancelled', 'the coach has cancelled this session and the full fee was already refunded', 409);
    }

    // Notice is measured in absolute hours from now to the session start, so a
    // cancellation made after the start refunds nothing rather than going
    // negative and refunding more.
    const percent = refundPercent(hoursOfNotice(new Date(), new Date(booking.starts_at)));
    const refund = refundAmount(Number(booking.credits_charged), percent);

    await client.query(
      "update enrolment set status = 'cancelled', credits_refunded = $1, cancelled_at = now() where id = $2",
      [refund, booking.id]
    );
    if (refund > 0) {
      await client.query('update person set credits = credits + $1 where id = $2', [refund, personId]);
      await client.query(
        "insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'booking cancellation refund', $3)",
        [personId, refund, sessionId]
      );
    }
    return { refund, refundPercent: percent, bookingId: booking.id };
  });
}

/**
 * Used only by the assistant's visitor-booking path. An address that already
 * belongs to an account is refused rather than reused: booking on behalf of an
 * existing account from an unauthenticated conversation would let anyone spend
 * someone else's credits by naming their email.
 */
export async function createVisitorParticipant(email: string, fullName = 'New Atrium participant') {
  const existing = await query<any>(
    'select id, email, full_name, kind, credits, active from person where lower(email) = lower($1)',
    [email]
  );
  if (existing[0]) return { ...existing[0], created: false };

  const inserted = await query<any>(
    `insert into person (email, password_hash, full_name, kind, credits, active, created_at)
     values ($1, null, $2, 'participant', 4000, true, now())
     returning id, email, full_name, kind, credits, active`,
    [email, fullName]
  );
  return { ...inserted[0], created: true };
}
