import { Router } from 'express';
import { query, withTransaction } from '../db';
import { CurrentUser, requireRole, requireSession } from '../auth';
import { hoursOfNotice, refundAmount, refundPercent, roomFee, seatFee } from '../credits';
import { validateSessionWindow } from '../domain';
import { notifyAdmins, notifySessionCancelled, notifySessionChanged } from '../notifications';

const router = Router();

function asId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) return null;
  return value;
}

async function sessionFeed(from: string, to: string | null, user: CurrentUser | undefined) {
  const params: unknown[] = [from];
  let sql = `select s.id, s.room_id, s.coach_id, s.discipline, s.session_type, s.status,
                    s.starts_at, s.ends_at, s.room_fee_credits, s.seat_fee_credits,
                    r.name as room_name, r.capacity as room_capacity,
                    p.full_name as coach_name,
                    count(e.id) filter (where e.status = 'active')::int as enrolled_count
               from session s
               join room r on r.id = s.room_id
               join person p on p.id = s.coach_id
               left join enrolment e on e.session_id = s.id
              where s.starts_at >= $1 and s.status <> 'cancelled'`;
  if (to) {
    params.push(to);
    sql += ` and s.starts_at < $${params.length}`;
  }
  sql += ` group by s.id, r.id, p.id order by s.starts_at`;
  const rows = await query<any>(sql, params);
  return rows.map((row) => ({
    ...row,
    enrolled_count: Number(row.enrolled_count),
    places_remaining: Math.max(0, Number(row.room_capacity) - Number(row.enrolled_count)),
    own_booking: user?.kind === 'participant' ? null : undefined
  }));
}

router.get('/', async (req, res) => {
  try {
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : new Date().toISOString();
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : null;
    const user = res.locals.user as CurrentUser | undefined;
    const feed = await sessionFeed(from, to, user);

    if (user?.kind === 'participant') {
      const ids = feed.map((session) => session.id);
      const bookings = ids.length
        ? await query<{ session_id: number; status: string }>(
            `select session_id, status from enrolment where person_id = $1 and session_id = any($2::int[])`,
            [user.id, ids]
          )
        : [];
      const bookingBySession = new Map(bookings.map((booking) => [booking.session_id, booking.status]));
      for (const session of feed) session.own_booking = bookingBySession.get(session.id) || null;
    }

    res.json(feed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not load the calendar' });
  }
});

router.get('/:id', requireSession, async (req, res) => {
  try {
    const id = asId(req.params.id);
    if (!id) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const user = res.locals.user as CurrentUser;
    const sessions = await query<any>(
      `select s.*, r.name as room_name, r.capacity as room_capacity,
              p.full_name as coach_name, p.email as coach_email
         from session s join room r on r.id = s.room_id join person p on p.id = s.coach_id
        where s.id = $1`,
      [id]
    );
    const session = sessions[0];
    if (!session) {
      res.status(404).json({ error: 'no such session' });
      return;
    }

    if (user.kind === 'participant' && user.id !== session.coach_id) {
      const own = await query<any>(
        `select e.id, e.status, e.credits_charged, e.credits_refunded, e.enrolled_at, e.cancelled_at
           from enrolment e where e.session_id = $1 and e.person_id = $2`,
        [id, user.id]
      );
      res.json({ ...session, attendee_count: await countAttendees(id), own_booking: own[0] || null });
      return;
    }

    if (user.kind === 'coach' && user.id !== session.coach_id) {
      res.json({ ...session, attendee_count: await countAttendees(id), attendees: undefined });
      return;
    }

    const attendees = await query(
      `select e.id, e.status, e.credits_charged, e.credits_refunded, e.enrolled_at, e.cancelled_at,
              p.id as person_id, p.full_name, p.email
         from enrolment e join person p on p.id = e.person_id
        where e.session_id = $1 order by e.id`,
      [id]
    );
    res.json({ ...session, attendees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not load the session' });
  }
});

async function countAttendees(sessionId: number): Promise<number> {
  const rows = await query<{ count: number }>(
    `select count(*)::int as count from enrolment where session_id = $1 and status = 'active'`,
    [sessionId]
  );
  return Number(rows[0]?.count || 0);
}

async function assertPersonIsFree(client: any, personId: number, startsAt: string, endsAt: string, ignoreSessionId?: number) {
  const rows = await client.query(
    `select s.id from session s
      where s.status <> 'cancelled'
        and ($4::int is null or s.id <> $4)
        and s.starts_at < $3 and $2 < s.ends_at
        and (s.coach_id = $1 or exists (
          select 1 from enrolment e where e.session_id = s.id and e.person_id = $1 and e.status = 'active'
        )) limit 1`,
    [personId, startsAt, endsAt, ignoreSessionId ?? null]
  );
  if (rows.rowCount) throw new Error('person_conflict');
}

async function assertRoomIsFree(client: any, roomId: number, startsAt: string, endsAt: string, ignoreSessionId?: number) {
  const rows = await client.query(
    `select id from session where room_id = $1 and status <> 'cancelled'
      and ($4::int is null or id <> $4) and starts_at < $3 and $2 < ends_at limit 1`,
    [roomId, startsAt, endsAt, ignoreSessionId ?? null]
  );
  if (rows.rowCount) throw new Error('room_conflict');
}

router.post('/', requireSession, requireRole('admin', 'coach'), async (req, res) => {
  try {
    const user = res.locals.user as CurrentUser;
    const roomId = asId(req.body?.room_id);
    const requestedCoachId = asId(req.body?.coach_id);
    const coachId = user.kind === 'coach' ? user.id : requestedCoachId;
    const discipline = typeof req.body?.discipline === 'string' ? req.body.discipline.trim() : '';
    const type = typeof req.body?.session_type === 'string' ? req.body.session_type : '';
    const startsAt = parseDate(req.body?.starts_at);
    const endsAt = parseDate(req.body?.ends_at);
    if (!roomId || !coachId || !discipline || !startsAt || !endsAt) {
      res.status(400).json({ error: 'room, coach, discipline, type, start, and end are required' });
      return;
    }
    const windowError = validateSessionWindow(type, startsAt, endsAt);
    if (windowError) {
      res.status(400).json({ error: windowError });
      return;
    }
    if (user.kind === 'coach' && new Date(startsAt).getTime() - Date.now() < 48 * 60 * 60 * 1000) {
      res.status(400).json({ error: 'coaches must book a room at least 48 hours before the session' });
      return;
    }

    const created = await withTransaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`room:${roomId}`]);
      const room = await client.query('select id, name, capacity from room where id = $1', [roomId]);
      const coach = await client.query("select id, credits, kind, active from person where id = $1", [coachId]);
      if (!room.rowCount) throw new Error('room_not_found');
      if (!coach.rowCount || coach.rows[0].kind !== 'coach' || !coach.rows[0].active) throw new Error('coach_not_found');
      await assertRoomIsFree(client, roomId, startsAt, endsAt);
      await assertPersonIsFree(client, coachId, startsAt, endsAt);
      const fee = roomFee(type);
      const inserted = await client.query(
        `insert into session (room_id, coach_id, discipline, session_type, status, starts_at, ends_at, room_fee_credits, seat_fee_credits)
         values ($1, $2, $3, $4, 'scheduled', $5, $6, $7, $8) returning *`,
        [roomId, coachId, discipline, type, startsAt, endsAt, fee, seatFee(type)]
      );
      const debit = await client.query(
        `update person set credits = credits - $1 where id = $2 and credits >= $1 returning credits`,
        [fee, coachId]
      );
      if (!debit.rowCount) throw new Error('insufficient_credits');
      await client.query(
        `insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, $3, $4)`,
        [coachId, -fee, 'room booking', inserted.rows[0].id]
      );
      return inserted.rows[0];
    });
    void notifyAdmins('New room booking', `A coach booked ${created.discipline} for ${new Date(created.starts_at).toLocaleString()}.`).catch(console.error);
    res.status(201).json(created);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const status = ['room_conflict', 'person_conflict'].includes(message) ? 409 : ['room_not_found', 'coach_not_found', 'insufficient_credits'].includes(message) ? 400 : 500;
    const errors: Record<string, string> = {
      room_conflict: 'that room is already booked for this interval',
      person_conflict: 'the coach already has an overlapping commitment',
      room_not_found: 'that room does not exist',
      coach_not_found: 'choose an active coach',
      insufficient_credits: 'the coach does not have enough credits'
    };
    if (status >= 500) console.error(err);
    res.status(status).json({ error: errors[message] || 'could not create the session' });
  }
});

router.patch('/:id', requireSession, requireRole('admin', 'coach'), async (req, res) => {
  try {
    const id = asId(req.params.id);
    const user = res.locals.user as CurrentUser;
    if (!id) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const updated = await withTransaction(async (client) => {
      const current = await client.query('select * from session where id = $1 for update', [id]);
      if (!current.rowCount) throw new Error('not_found');
      const session = current.rows[0];
      if (user.kind === 'coach' && session.coach_id !== user.id) throw new Error('forbidden');
      if (req.body?.room_id !== undefined || req.body?.coach_id !== undefined || req.body?.session_type !== undefined) {
        throw new Error('structural_change_requires_rebook');
      }
      const roomId = session.room_id;
      const coachId = session.coach_id;
      const type = session.session_type;
      const startsAt = parseDate(req.body?.starts_at) ?? new Date(session.starts_at).toISOString();
      const endsAt = parseDate(req.body?.ends_at) ?? new Date(session.ends_at).toISOString();
      const windowError = validateSessionWindow(type, startsAt, endsAt);
      if (windowError) throw new Error(windowError);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`room:${roomId}`]);
      await assertRoomIsFree(client, roomId, startsAt, endsAt, id);
      await assertPersonIsFree(client, coachId, startsAt, endsAt, id);
      const result = await client.query(
        `update session set discipline = $1, starts_at = $2, ends_at = $3
          where id = $4 returning *`,
        [String(req.body?.discipline || session.discipline).trim(), startsAt, endsAt, id]
      );
      return result.rows[0];
    });
    void notifySessionChanged(id).catch(console.error);
    res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const status = message === 'forbidden' ? 403 : message === 'not_found' ? 404 : ['room_conflict', 'person_conflict'].includes(message) ? 409 : 400;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message === 'forbidden' ? 'you can only change your own sessions' : message === 'structural_change_requires_rebook' ? 'changing the room, coach, or session type requires a new booking so credits remain correct' : message || 'could not update the session' });
  }
});

router.post('/:id/cancel', requireSession, requireRole('admin', 'coach'), async (req, res) => {
  try {
    const id = asId(req.params.id);
    const user = res.locals.user as CurrentUser;
    if (!id) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const summary = await withTransaction(async (client) => {
      const rows = await client.query('select * from session where id = $1 for update', [id]);
      if (!rows.rowCount) throw new Error('not_found');
      const session = rows.rows[0];
      if (user.kind === 'coach' && session.coach_id !== user.id) throw new Error('forbidden');
      if (session.status === 'cancelled') throw new Error('already_cancelled');
      const coachPercent = refundPercent(hoursOfNotice(new Date(), new Date(session.starts_at)));
      const coachRefund = refundAmount(Number(session.room_fee_credits), coachPercent);
      const enrolments = await client.query(
        `select id, person_id, credits_charged from enrolment where session_id = $1 and status = 'active' for update`,
        [id]
      );
      let participantRefund = 0;
      for (const enrolment of enrolments.rows) {
        const refund = Number(enrolment.credits_charged);
        participantRefund += refund;
        await client.query(
          `update enrolment set status = 'cancelled', credits_refunded = $1, cancelled_at = now() where id = $2`,
          [refund, enrolment.id]
        );
        await client.query('update person set credits = credits + $1 where id = $2', [refund, enrolment.person_id]);
        await client.query(
          `insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'coach cancelled session', $3)`,
          [enrolment.person_id, refund, id]
        );
      }
      if (coachRefund) {
        await client.query('update person set credits = credits + $1 where id = $2', [coachRefund, session.coach_id]);
        await client.query(
          `insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'room cancellation refund', $3)`,
          [session.coach_id, coachRefund, id]
        );
      }
      await client.query("update session set status = 'cancelled' where id = $1", [id]);
      return { coachRefund, participantRefund, affected: enrolments.rowCount, refundPercent: coachPercent };
    });
    void notifySessionCancelled(id).catch(console.error);
    void notifyAdmins('Session cancelled', `Session ${id} was cancelled and affected participants were refunded.`).catch(console.error);
    res.json({ id, status: 'cancelled', ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const status = message === 'forbidden' ? 403 : message === 'not_found' ? 404 : message === 'already_cancelled' ? 409 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: message === 'forbidden' ? 'you can only cancel your own sessions' : message || 'could not cancel the session' });
  }
});

export default router;
