import { query, withTransaction } from '../db';
import { hoursOfNotice, refundAmount, refundPercent } from '../credits';

export async function bookSessionForPerson(personId: number, sessionId: number) {
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`person:${personId}`]);
    const sessions = await client.query(
      `select s.*, r.capacity from session s join room r on r.id = s.room_id where s.id = $1 for update`,
      [sessionId]
    );
    if (!sessions.rowCount || sessions.rows[0].status === 'cancelled') throw new Error('not_found');
    const session = sessions.rows[0];
    if (session.coach_id === personId) throw new Error('own_session');
    if (new Date(session.starts_at).getTime() <= Date.now()) throw new Error('past_session');
    const existing = await client.query(
      `select id, status from enrolment where session_id = $1 and person_id = $2 for update`,
      [sessionId, personId]
    );
    if (existing.rows.some((row: any) => row.status === 'active')) throw new Error('already_booked');
    const count = await client.query(
      `select count(*)::int as count from enrolment where session_id = $1 and status = 'active'`,
      [sessionId]
    );
    if (Number(count.rows[0].count) >= Number(session.capacity)) throw new Error('full');
    const conflicts = await client.query(
      `select s.id from session s
        where s.status <> 'cancelled' and s.starts_at < $3 and $2 < s.ends_at
          and (s.coach_id = $1 or exists (
            select 1 from enrolment e where e.session_id = s.id and e.person_id = $1 and e.status = 'active'
          )) limit 1`,
      [personId, session.starts_at, session.ends_at]
    );
    if (conflicts.rowCount) throw new Error('person_conflict');
    const charge = Number(session.seat_fee_credits);
    const debit = await client.query(
      `update person set credits = credits - $1 where id = $2 and credits >= $1 returning credits`,
      [charge, personId]
    );
    if (!debit.rowCount) throw new Error('insufficient_credits');
    const inserted = await client.query(
      `insert into enrolment (session_id, person_id, status, credits_charged, credits_refunded, enrolled_at)
       values ($1, $2, 'active', $3, 0, now()) returning *`,
      [sessionId, personId, charge]
    );
    await client.query(
      `insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'session booking', $3)`,
      [personId, -charge, sessionId]
    );
    return inserted.rows[0];
  });
}

export async function createVisitorParticipant(email: string, fullName = 'New Atrium participant') {
  const existing = await query<any>('select id, email, full_name, kind, credits, active, password_hash from person where lower(email) = lower($1)', [email]);
  if (existing[0]) return { ...existing[0], created: false };
  const inserted = await query<any>(
    `insert into person (email, password_hash, full_name, kind, credits, active, created_at)
     values ($1, null, $2, 'participant', 4000, true, now()) returning id, email, full_name, kind, credits, active`,
    [email, fullName]
  );
  return { ...inserted[0], created: true };
}

export async function cancelBookingForPerson(personId: number, sessionId: number) {
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`person:${personId}`]);
    const rows = await client.query(
      `select e.*, s.starts_at, s.status as session_status from enrolment e join session s on s.id = e.session_id
        where e.session_id = $1 and e.person_id = $2 and e.status = 'active' for update`,
      [sessionId, personId]
    );
    if (!rows.rowCount) throw new Error('not_found');
    const booking = rows.rows[0];
    if (booking.session_status === 'cancelled') throw new Error('session_cancelled');
    const percent = refundPercent(hoursOfNotice(new Date(), new Date(booking.starts_at)));
    const refund = refundAmount(Number(booking.credits_charged), percent);
    await client.query(
      `update enrolment set status = 'cancelled', credits_refunded = $1, cancelled_at = now() where id = $2`,
      [refund, booking.id]
    );
    if (refund) {
      await client.query('update person set credits = credits + $1 where id = $2', [refund, personId]);
      await client.query(
        `insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'booking cancellation refund', $3)`,
        [personId, refund, sessionId]
      );
    }
    return { refund, refundPercent: percent, bookingId: booking.id };
  });
}
