import { Router } from 'express';
import { CurrentUser, requireSession } from '../auth';
import { query } from '../db';

const router = Router();

router.get('/', requireSession, async (req, res) => {
  try {
    const user = res.locals.user as CurrentUser;
    const from = typeof req.query.from === 'string' ? req.query.from : new Date().toISOString();
    const to = typeof req.query.to === 'string' ? req.query.to : new Date(Date.now() + 14 * 86400000).toISOString();
    const params: unknown[] = [from, to];
    let where = `s.starts_at >= $1 and s.starts_at < $2 and s.status <> 'cancelled'`;
    if (user.kind === 'coach') {
      params.push(user.id);
      where += ` and (s.coach_id = $${params.length} or exists (
        select 1 from enrolment me where me.session_id = s.id and me.person_id = $${params.length} and me.status = 'active'
      ))`;
    } else if (user.kind === 'participant') {
      params.push(user.id);
      where += ` and exists (
        select 1 from enrolment me where me.session_id = s.id and me.person_id = $${params.length} and me.status = 'active'
      )`;
    }

    const sessions = await query<any>(
      `select s.id, s.discipline, s.session_type, s.status, s.starts_at, s.ends_at,
              s.coach_id, p.full_name as coach_name, r.name as room_name, r.capacity as room_capacity,
              count(e.id) filter (where e.status = 'active')::int as enrolled_count
         from session s join room r on r.id = s.room_id join person p on p.id = s.coach_id
         left join enrolment e on e.session_id = s.id
        where ${where}
        group by s.id, p.id, r.id order by s.starts_at`,
      params
    );

    const result = [];
    for (const session of sessions) {
      const isOwner = user.kind === 'admin' || user.kind === 'participant' || (user.kind === 'coach' && user.id === session.coach_id);
      result.push({
        ...session,
        enrolled_count: Number(session.enrolled_count),
        places_remaining: Math.max(0, Number(session.room_capacity) - Number(session.enrolled_count)),
        visibility: isOwner ? 'details' : 'busy'
      });
    }
    res.json({ timezone: process.env.CENTRE_TIMEZONE || 'America/New_York', sessions: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not load the calendar' });
  }
});

export default router;
