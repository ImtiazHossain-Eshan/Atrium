import { Router } from 'express';
import { CurrentUser, requireSession } from '../auth';
import { query } from '../db';

const router = Router();

router.get('/', requireSession, async (_req, res) => {
  try {
    const user = res.locals.user as CurrentUser;
    if (user.kind === 'admin') {
      const [rooms, people, sessions, upcoming] = await Promise.all([
        query<{ count: number }>('select count(*)::int as count from room'),
        query<{ count: number }>('select count(*)::int as count from person where active = true'),
        query<{ count: number }>("select count(*)::int as count from session where status <> 'cancelled'"),
        query<any>(
          `select s.id, s.discipline, s.starts_at, r.name as room_name, p.full_name as coach_name,
                  count(e.id) filter (where e.status = 'active')::int as enrolled_count, r.capacity
             from session s join room r on r.id = s.room_id join person p on p.id = s.coach_id
             left join enrolment e on e.session_id = s.id
            where s.status <> 'cancelled' and s.starts_at >= now()
            group by s.id, r.id, p.id order by s.starts_at limit 8`
        )
      ]);
      res.json({ role: user.kind, stats: { rooms: rooms[0].count, people: people[0].count, sessions: sessions[0].count }, upcoming });
      return;
    }

    if (user.kind === 'coach') {
      const [sessions, attendees, upcoming] = await Promise.all([
        query<{ count: number }>("select count(*)::int as count from session where coach_id = $1 and status <> 'cancelled'", [user.id]),
        query<{ count: number }>(
          `select count(*)::int as count from enrolment e join session s on s.id = e.session_id
            where s.coach_id = $1 and e.status = 'active'`,
          [user.id]
        ),
        query<any>(
          `select s.id, s.discipline, s.starts_at, s.ends_at, r.name as room_name, r.capacity,
                  count(e.id) filter (where e.status = 'active')::int as enrolled_count
             from session s join room r on r.id = s.room_id left join enrolment e on e.session_id = s.id
            where s.coach_id = $1 and s.status <> 'cancelled' and s.starts_at >= now()
            group by s.id, r.id order by s.starts_at limit 8`,
          [user.id]
        )
      ]);
      res.json({ role: user.kind, stats: { sessions: sessions[0].count, attendees: attendees[0].count, credits: user.credits }, upcoming });
      return;
    }

    const [bookings, upcoming] = await Promise.all([
      query<{ count: number }>("select count(*)::int as count from enrolment where person_id = $1 and status = 'active'", [user.id]),
      query<any>(
        `select s.id, s.discipline, s.starts_at, s.ends_at, r.name as room_name, p.full_name as coach_name,
                e.credits_charged
           from enrolment e join session s on s.id = e.session_id join room r on r.id = s.room_id join person p on p.id = s.coach_id
          where e.person_id = $1 and e.status = 'active' and s.status <> 'cancelled' and s.starts_at >= now()
          order by s.starts_at limit 8`,
        [user.id]
      )
    ]);
    res.json({ role: user.kind, stats: { bookings: bookings[0].count, credits: user.credits }, upcoming });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not load the dashboard' });
  }
});

export default router;
