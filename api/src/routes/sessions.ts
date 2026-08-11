import { Router } from 'express';
import { query } from '../db';
import { CurrentUser, requireRole, requireSession } from '../auth';
import { DomainError, cancelSession, createSession, rescheduleSession } from '../services/sessions';

const router = Router();

function asId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) return null;
  return value;
}

function fail(res: any, err: unknown, fallback: string): void {
  if (err instanceof DomainError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: fallback });
}

/**
 * The public catalogue. Readable without signing in, because a visitor needs to
 * see what is running, when, at what cost and how many places remain before
 * they can decide to book.
 *
 * `attachUser` runs ahead of this router, so a signed-in caller is known here
 * and gets their own booking state alongside each row. Without that middleware
 * the enrichment below silently never ran and a participant who had already
 * booked was still offered the booking button.
 */
async function sessionFeed(from: string, to: string | null) {
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
    places_remaining: Math.max(0, Number(row.room_capacity) - Number(row.enrolled_count))
  }));
}

router.get('/', async (req, res) => {
  try {
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : new Date().toISOString();
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : null;
    const user = (res.locals.user as CurrentUser | null) ?? null;
    const feed = await sessionFeed(from, to);

    // Coaches attend one another's sessions, so their own booking state matters
    // on this board too, not only a participant's.
    if (user && user.kind !== 'admin' && feed.length) {
      const bookings = await query<{ session_id: number; status: string }>(
        `select session_id, status from enrolment
          where person_id = $1 and session_id = any($2::int[])`,
        [user.id, feed.map((session) => session.id)]
      );
      const bySession = new Map(bookings.map((booking) => [booking.session_id, booking.status]));
      for (const session of feed) (session as any).own_booking = bySession.get(session.id) ?? null;
    }

    res.json(feed);
  } catch (err) {
    fail(res, err, 'could not load the sessions');
  }
});

async function countAttendees(sessionId: number): Promise<number> {
  const rows = await query<{ count: number }>(
    `select count(*)::int as count from enrolment where session_id = $1 and status = 'active'`,
    [sessionId]
  );
  return Number(rows[0]?.count || 0);
}

/**
 * Session detail. What comes back is assembled per role rather than filtered
 * out of a single row, so a column added to the query later cannot leak by
 * default. The coach's email address is centre contact detail and is only
 * returned to the people who administer or own the session.
 */
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

    const isOwner = user.kind === 'admin' || (user.kind === 'coach' && user.id === session.coach_id);

    const publicView = {
      id: session.id,
      room_id: session.room_id,
      coach_id: session.coach_id,
      coach_name: session.coach_name,
      discipline: session.discipline,
      session_type: session.session_type,
      status: session.status,
      starts_at: session.starts_at,
      ends_at: session.ends_at,
      seat_fee_credits: session.seat_fee_credits,
      room_name: session.room_name,
      room_capacity: session.room_capacity,
      attendee_count: await countAttendees(id)
    };

    if (!isOwner) {
      // A participant may see their own place in this session and nothing about
      // anyone else's. A coach who does not own it sees the same catalogue view.
      const own = await query<any>(
        `select e.id, e.status, e.credits_charged, e.credits_refunded, e.enrolled_at, e.cancelled_at
           from enrolment e where e.session_id = $1 and e.person_id = $2`,
        [id, user.id]
      );
      res.json({ ...publicView, places_remaining: Math.max(0, Number(session.room_capacity) - publicView.attendee_count), own_booking: own[0] || null });
      return;
    }

    const attendees = await query(
      `select e.id, e.status, e.credits_charged, e.credits_refunded, e.enrolled_at, e.cancelled_at,
              p.id as person_id, p.full_name, p.email,
              (c.id is not null) as attended
         from enrolment e
         join person p on p.id = e.person_id
         left join check_in c on c.enrolment_id = e.id
        where e.session_id = $1 order by p.full_name`,
      [id]
    );
    res.json({
      ...publicView,
      coach_email: session.coach_email,
      room_fee_credits: session.room_fee_credits,
      attendees
    });
  } catch (err) {
    fail(res, err, 'could not load the session');
  }
});

router.post('/', requireSession, requireRole('admin', 'coach'), async (req, res) => {
  try {
    const user = res.locals.user as CurrentUser;
    const roomId = asId(req.body?.room_id);
    const requestedCoachId = asId(req.body?.coach_id);
    // A coach books for themselves. The coach_id in the body is only honoured
    // for an administrator, so it cannot be used to charge someone else.
    const coachId = user.kind === 'coach' ? user.id : requestedCoachId;
    const discipline = typeof req.body?.discipline === 'string' ? req.body.discipline.trim() : '';
    const sessionType = typeof req.body?.session_type === 'string' ? req.body.session_type : '';
    const startsAt = parseDate(req.body?.starts_at);
    const endsAt = parseDate(req.body?.ends_at);

    if (!roomId || !coachId || !discipline || !startsAt || !endsAt) {
      res.status(400).json({ error: 'room, coach, discipline, type, start, and end are required' });
      return;
    }

    const created = await createSession(
      { id: user.id, kind: user.kind },
      { roomId, coachId, discipline, sessionType, startsAt, endsAt }
    );
    res.status(201).json(created);
  } catch (err) {
    fail(res, err, 'could not create the session');
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
    if (req.body?.room_id !== undefined || req.body?.coach_id !== undefined || req.body?.session_type !== undefined) {
      res.status(400).json({
        error: 'changing the room, coach, or session type requires a new booking so credits remain correct'
      });
      return;
    }

    const current = await query<any>('select starts_at, ends_at from session where id = $1', [id]);
    if (!current[0]) {
      res.status(404).json({ error: 'no such session' });
      return;
    }

    const startsAt = parseDate(req.body?.starts_at) ?? new Date(current[0].starts_at).toISOString();
    const endsAt = parseDate(req.body?.ends_at) ?? new Date(current[0].ends_at).toISOString();
    const discipline = typeof req.body?.discipline === 'string' ? req.body.discipline : undefined;

    const updated = await rescheduleSession(id, { id: user.id, kind: user.kind }, startsAt, endsAt, discipline);
    res.json(updated);
  } catch (err) {
    fail(res, err, 'could not update the session');
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
    const summary = await cancelSession(id, { id: user.id, kind: user.kind });
    res.json({
      id,
      status: 'cancelled',
      coachRefund: summary.coachRefund,
      refundPercent: summary.refundPercent,
      participantRefund: summary.participantRefund,
      affected: summary.affected
    });
  } catch (err) {
    fail(res, err, 'could not cancel the session');
  }
});

export default router;
