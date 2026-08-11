import { Router } from 'express';
import { CurrentUser, requireSession } from '../auth';
import { query } from '../db';
import { CENTRE_TIMEZONE } from '../domain';

const router = Router();

type CalendarRow = {
  id: number;
  discipline: string;
  session_type: string;
  status: string;
  starts_at: string;
  ends_at: string;
  coach_id: number;
  coach_name: string;
  room_name: string;
  room_capacity: number;
  enrolled_count: number;
  relation: 'teaching' | 'attending' | 'other';
};

/**
 * Section 7 gives each role a different calendar:
 *
 *   participant — only the sessions they hold a place in.
 *   coach       — their own sessions and the ones they attend in full, plus
 *                 every other active session as an opaque busy period so they
 *                 can plan around the room. Never who is attending those.
 *   admin       — everything.
 *
 * The narrowing happens in SQL and in the projection below, not in the client.
 * A busy period is built by dropping fields, so a field that is not selected
 * for that branch cannot be forgotten on the way out.
 */
router.get('/', requireSession, async (req, res) => {
  try {
    const user = res.locals.user as CurrentUser;
    const from = typeof req.query.from === 'string' ? req.query.from : new Date().toISOString();
    const to = typeof req.query.to === 'string' ? req.query.to : new Date(Date.now() + 14 * 86400000).toISOString();

    const params: unknown[] = [from, to];
    let where = `s.starts_at >= $1 and s.starts_at < $2 and s.status <> 'cancelled'`;
    let relation = `'other'`;

    if (user.kind === 'coach') {
      params.push(user.id);
      const me = `$${params.length}`;
      // Other coaches' sessions stay in the result set: a coach is entitled to
      // know the room is taken. What they are not entitled to is who is in it.
      relation = `case
        when s.coach_id = ${me} then 'teaching'
        when exists (select 1 from enrolment e2 where e2.session_id = s.id and e2.person_id = ${me} and e2.status = 'active') then 'attending'
        else 'other' end`;
    } else if (user.kind === 'participant') {
      params.push(user.id);
      where += ` and exists (
        select 1 from enrolment me where me.session_id = s.id and me.person_id = $${params.length} and me.status = 'active'
      )`;
      relation = `'attending'`;
    }

    const sessions = await query<CalendarRow>(
      `select s.id, s.discipline, s.session_type, s.status, s.starts_at, s.ends_at,
              s.coach_id, p.full_name as coach_name, r.name as room_name, r.capacity as room_capacity,
              count(e.id) filter (where e.status = 'active')::int as enrolled_count,
              ${relation} as relation
         from session s
         join room r on r.id = s.room_id
         join person p on p.id = s.coach_id
         left join enrolment e on e.session_id = s.id
        where ${where}
        group by s.id, p.id, r.id
        order by s.starts_at`,
      params
    );

    const result = sessions.map((session) => {
      if (session.relation === 'other') {
        // Time and room only. Discipline, coach identity and headcount are all
        // withheld — the caller learns that the room is unavailable, nothing more.
        return {
          id: session.id,
          starts_at: session.starts_at,
          ends_at: session.ends_at,
          room_name: session.room_name,
          visibility: 'busy' as const
        };
      }
      return {
        id: session.id,
        discipline: session.discipline,
        session_type: session.session_type,
        status: session.status,
        starts_at: session.starts_at,
        ends_at: session.ends_at,
        coach_id: session.coach_id,
        coach_name: session.coach_name,
        room_name: session.room_name,
        room_capacity: Number(session.room_capacity),
        enrolled_count: Number(session.enrolled_count),
        places_remaining: Math.max(0, Number(session.room_capacity) - Number(session.enrolled_count)),
        relation: session.relation,
        visibility: 'details' as const
      };
    });

    res.json({ timezone: CENTRE_TIMEZONE, sessions: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not load the calendar' });
  }
});

export default router;
