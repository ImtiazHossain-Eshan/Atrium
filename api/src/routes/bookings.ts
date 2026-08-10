import { Router } from 'express';
import { CurrentUser, requireRole, requireSession } from '../auth';
import { query, withTransaction } from '../db';
import { hoursOfNotice, refundAmount, refundPercent } from '../credits';
import { notifyBooking, notifyBookingCancelled } from '../notifications';

const router = Router();

function idFrom(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function assertPersonFree(client: any, personId: number, startsAt: Date, endsAt: Date) {
  const conflicts = await client.query(
    `select s.id from session s
      where s.status <> 'cancelled' and s.starts_at < $3 and $2 < s.ends_at
        and (s.coach_id = $1 or exists (
          select 1 from enrolment e where e.session_id = s.id and e.person_id = $1 and e.status = 'active'
        )) limit 1`,
    [personId, startsAt, endsAt]
  );
  if (conflicts.rowCount) throw new Error('person_conflict');
}

router.get('/', requireSession, async (_req, res) => {
  try {
    const user = res.locals.user as CurrentUser;
    const rows = await query(
      `select e.id as booking_id, e.status as booking_status, e.credits_charged,
              e.credits_refunded, e.enrolled_at, e.cancelled_at,
              s.id as session_id, s.discipline, s.session_type, s.status as session_status,
              s.starts_at, s.ends_at, s.seat_fee_credits,
              r.name as room_name, r.capacity as room_capacity,
              p.full_name as coach_name
         from enrolment e
         join session s on s.id = e.session_id
         join room r on r.id = s.room_id
         join person p on p.id = s.coach_id
        where e.person_id = $1
        order by s.starts_at desc`,
      [user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not load your bookings' });
  }
});

router.post('/:sessionId/book', requireSession, requireRole('participant', 'coach'), async (req, res) => {
  try {
    const sessionId = idFrom(req.params.sessionId);
    const user = res.locals.user as CurrentUser;
    if (!sessionId) {
      res.status(404).json({ error: 'no such session' });
      return;
    }

    const booking = await withTransaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`person:${user.id}`]);
      const sessions = await client.query(
        `select s.*, r.capacity, p.kind as coach_kind
           from session s join room r on r.id = s.room_id join person p on p.id = s.coach_id
          where s.id = $1 for update`,
        [sessionId]
      );
      if (!sessions.rowCount || sessions.rows[0].status === 'cancelled') throw new Error('not_found');
      const session = sessions.rows[0];
      if (session.coach_id === user.id) throw new Error('own_session');
      if (new Date(session.starts_at).getTime() <= Date.now()) throw new Error('past_session');
      const existing = await client.query(
        `select id, status from enrolment where session_id = $1 and person_id = $2 for update`,
        [sessionId, user.id]
      );
      if (existing.rows.some((row: any) => row.status === 'active')) throw new Error('already_booked');
      const count = await client.query(
        `select count(*)::int as count from enrolment where session_id = $1 and status = 'active'`,
        [sessionId]
      );
      if (Number(count.rows[0].count) >= Number(session.capacity)) throw new Error('full');
      await assertPersonFree(client, user.id, new Date(session.starts_at), new Date(session.ends_at));
      const charge = Number(session.seat_fee_credits);
      const debit = await client.query(
        `update person set credits = credits - $1 where id = $2 and credits >= $1 returning credits`,
        [charge, user.id]
      );
      if (!debit.rowCount) throw new Error('insufficient_credits');
      const inserted = await client.query(
        `insert into enrolment (session_id, person_id, status, credits_charged, credits_refunded, enrolled_at)
         values ($1, $2, 'active', $3, 0, now()) returning *`,
        [sessionId, user.id, charge]
      );
      await client.query(
        `insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'session booking', $3)`,
        [user.id, -charge, sessionId]
      );
      return inserted.rows[0];
    });
    void notifyBooking(sessionId, user.id).catch(console.error);
    res.status(201).json(booking);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const errors: Record<string, string> = {
      not_found: 'that session is no longer available',
      own_session: 'a coach cannot book their own session',
      past_session: 'past sessions cannot be booked',
      already_booked: 'you already have an active booking for this session',
      full: 'that session is full',
      person_conflict: 'you already have another overlapping commitment',
      insufficient_credits: 'you do not have enough credits for this place'
    };
    const status = ['already_booked', 'full', 'person_conflict', 'own_session'].includes(message) ? 409 : message === 'not_found' ? 404 : errors[message] ? 400 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: errors[message] || 'could not book this session' });
  }
});

router.post('/:sessionId/cancel', requireSession, requireRole('participant', 'coach'), async (req, res) => {
  try {
    const sessionId = idFrom(req.params.sessionId);
    const user = res.locals.user as CurrentUser;
    if (!sessionId) {
      res.status(404).json({ error: 'no such booking' });
      return;
    }
    const result = await withTransaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`person:${user.id}`]);
      const rows = await client.query(
        `select e.*, s.starts_at, s.status as session_status from enrolment e join session s on s.id = e.session_id
          where e.session_id = $1 and e.person_id = $2 and e.status = 'active' for update`,
        [sessionId, user.id]
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
        await client.query('update person set credits = credits + $1 where id = $2', [refund, user.id]);
        await client.query(
          `insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'booking cancellation refund', $3)`,
          [user.id, refund, sessionId]
        );
      }
      return { refund, refundPercent: percent, bookingId: booking.id };
    });
    void notifyBookingCancelled(sessionId, user.id).catch(console.error);
    res.json({ session_id: sessionId, status: 'cancelled', ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const status = message === 'not_found' ? 404 : message === 'session_cancelled' ? 409 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: message === 'session_cancelled' ? 'the coach has cancelled this session' : message || 'could not cancel this booking' });
  }
});

export default router;
