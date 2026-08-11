import { Router } from 'express';
import { CurrentUser, requireRole, requireSession } from '../auth';
import { query } from '../db';
import { notifyBooking, notifyBookingCancelled } from '../notifications';
import { bookSessionForPerson, cancelBookingForPerson } from '../services/bookings';
import { DomainError } from '../services/sessions';

const router = Router();

function idFrom(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function fail(res: any, err: unknown, fallback: string): void {
  if (err instanceof DomainError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: fallback });
}

/** A person's own bookings, and only their own. */
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
    fail(res, err, 'could not load your bookings');
  }
});

// Coaches attend one another's sessions, so both non-admin roles book places.
// An administrator does not: they would be spending someone else's credits.
router.post('/:sessionId/book', requireSession, requireRole('participant', 'coach'), async (req, res) => {
  try {
    const sessionId = idFrom(req.params.sessionId);
    const user = res.locals.user as CurrentUser;
    if (!sessionId) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const booking = await bookSessionForPerson(user.id, sessionId);
    void notifyBooking(sessionId, user.id).catch(console.error);
    res.status(201).json(booking);
  } catch (err) {
    fail(res, err, 'could not book this session');
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
    const result = await cancelBookingForPerson(user.id, sessionId);
    void notifyBookingCancelled(sessionId, user.id).catch(console.error);
    res.json({ session_id: sessionId, status: 'cancelled', ...result });
  } catch (err) {
    fail(res, err, 'could not cancel this booking');
  }
});

export default router;
