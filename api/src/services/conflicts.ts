import { PoolClient } from 'pg';

/**
 * Overlap tests shared by every write path.
 *
 * All intervals are half-open: `a.starts_at < b.ends_at and b.starts_at < a.ends_at`.
 * A session ending at 10:00 and one starting at 10:00 do not overlap, which is
 * why neither comparison is `<=`.
 *
 * An INTENSIVE is stored as one contiguous 210-minute hold rather than two
 * teaching blocks around a gap, so "nobody involved may be booked elsewhere
 * during the lunch interval" falls out of the same test: the interval that is
 * compared already spans the interval.
 */

export async function findRoomConflict(
  client: PoolClient,
  roomId: number,
  startsAt: string | Date,
  endsAt: string | Date,
  ignoreSessionId?: number
): Promise<number | null> {
  const rows = await client.query<{ id: number }>(
    `select id from session
      where room_id = $1 and status <> 'cancelled'
        and ($4::int is null or id <> $4)
        and starts_at < $3 and $2 < ends_at
      limit 1`,
    [roomId, startsAt, endsAt, ignoreSessionId ?? null]
  );
  return rows.rows[0]?.id ?? null;
}

/**
 * A commitment is a commitment whether the person is teaching it or attending
 * it, so both are tested in one predicate. Nobody can be in two rooms at once.
 */
export async function findPersonConflict(
  client: PoolClient,
  personId: number,
  startsAt: string | Date,
  endsAt: string | Date,
  ignoreSessionId?: number
): Promise<number | null> {
  const rows = await client.query<{ id: number }>(
    `select s.id from session s
      where s.status <> 'cancelled'
        and ($4::int is null or s.id <> $4)
        and s.starts_at < $3 and $2 < s.ends_at
        and (s.coach_id = $1 or exists (
          select 1 from enrolment e
           where e.session_id = s.id and e.person_id = $1 and e.status = 'active'
        ))
      limit 1`,
    [personId, startsAt, endsAt, ignoreSessionId ?? null]
  );
  return rows.rows[0]?.id ?? null;
}

/**
 * Every participant already holding a place in a session that is about to move.
 *
 * A reschedule carries its attendees with it, so the new interval has to be
 * legal for all of them, not just for the coach and the room.
 */
export async function findConflictedAttendees(
  client: PoolClient,
  sessionId: number,
  startsAt: string | Date,
  endsAt: string | Date
): Promise<{ person_id: number; full_name: string }[]> {
  const rows = await client.query<{ person_id: number; full_name: string }>(
    `select e.person_id, p.full_name
       from enrolment e
       join person p on p.id = e.person_id
      where e.session_id = $1 and e.status = 'active'
        and exists (
          select 1 from session other
           where other.status <> 'cancelled'
             and other.id <> $1
             and other.starts_at < $3 and $2 < other.ends_at
             and (other.coach_id = e.person_id or exists (
               select 1 from enrolment oe
                where oe.session_id = other.id and oe.person_id = e.person_id and oe.status = 'active'
             ))
        )
      order by p.full_name`,
    [sessionId, startsAt, endsAt]
  );
  return rows.rows;
}

export const COACH_BOOKING_NOTICE_MS = 48 * 60 * 60 * 1000;

/**
 * A coach must commit a room at least 48 hours ahead. Moving a session to a
 * time inside that window is the same commitment made late, so the deadline is
 * applied to the new start as well as to the original booking.
 */
export function violatesCoachNotice(startsAt: string | Date, now = new Date()): boolean {
  return new Date(startsAt).getTime() - now.getTime() < COACH_BOOKING_NOTICE_MS;
}
