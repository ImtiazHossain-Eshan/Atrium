import { query, withTransaction } from '../db';
import { hoursOfNotice, refundAmount, refundPercent } from '../credits';
import { validateSessionWindow } from '../domain';
import { notifyAdmins, notifySessionCancelled, notifySessionChanged } from '../notifications';

export async function cancelSessionForCoach(sessionId: number, coachId: number) {
  const summary = await withTransaction(async (client) => {
    const rows = await client.query('select * from session where id = $1 for update', [sessionId]);
    if (!rows.rowCount) throw new Error('not_found');
    const session = rows.rows[0];
    if (session.coach_id !== coachId) throw new Error('forbidden');
    if (session.status === 'cancelled') throw new Error('already_cancelled');

    const coachRefund = refundAmount(Number(session.room_fee_credits), refundPercent(hoursOfNotice(new Date(), new Date(session.starts_at))));
    const enrolments = await client.query('select id, person_id, credits_charged from enrolment where session_id = $1 and status = \'active\' for update', [sessionId]);
    for (const enrolment of enrolments.rows) {
      const refund = Number(enrolment.credits_charged);
      await client.query("update enrolment set status = 'cancelled', credits_refunded = $1, cancelled_at = now() where id = $2", [refund, enrolment.id]);
      await client.query('update person set credits = credits + $1 where id = $2', [refund, enrolment.person_id]);
      await client.query("insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'coach cancelled session', $3)", [enrolment.person_id, refund, sessionId]);
    }
    if (coachRefund) {
      await client.query('update person set credits = credits + $1 where id = $2', [coachRefund, coachId]);
      await client.query("insert into credit_ledger (person_id, amount, reason, reference_id) values ($1, $2, 'room cancellation refund', $3)", [coachId, coachRefund, sessionId]);
    }
    await client.query("update session set status = 'cancelled' where id = $1", [sessionId]);
    return { affected: enrolments.rowCount, coachRefund };
  });
  void notifySessionCancelled(sessionId).catch(console.error);
  void notifyAdmins('Session cancelled', `Session ${sessionId} was cancelled and affected participants were refunded.`).catch(console.error);
  return summary;
}

export async function rescheduleSessionForCoach(sessionId: number, coachId: number, startsAt: string, endsAt: string) {
  const updated = await withTransaction(async (client) => {
    const rows = await client.query('select * from session where id = $1 for update', [sessionId]);
    if (!rows.rowCount) throw new Error('not_found');
    const session = rows.rows[0];
    if (session.coach_id !== coachId) throw new Error('forbidden');
    if (session.status === 'cancelled') throw new Error('already_cancelled');
    const windowError = validateSessionWindow(session.session_type, startsAt, endsAt);
    if (windowError) throw new Error(windowError);
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`room:${session.room_id}`]);
    const roomConflict = await client.query('select id from session where room_id = $1 and status <> \'cancelled\' and id <> $2 and starts_at < $4 and $3 < ends_at limit 1', [session.room_id, sessionId, startsAt, endsAt]);
    if (roomConflict.rowCount) throw new Error('room_conflict');
    const personConflict = await client.query(`select s.id from session s where s.status <> 'cancelled' and s.id <> $4 and s.starts_at < $3 and $2 < s.ends_at and (s.coach_id = $1 or exists (select 1 from enrolment e where e.session_id = s.id and e.person_id = $1 and e.status = 'active')) limit 1`, [coachId, startsAt, endsAt, sessionId]);
    if (personConflict.rowCount) throw new Error('person_conflict');
    const result = await client.query('update session set starts_at = $1, ends_at = $2 where id = $3 returning *', [startsAt, endsAt, sessionId]);
    return result.rows[0];
  });
  void notifySessionChanged(sessionId).catch(console.error);
  return updated;
}

export async function sessionBelongsToCoach(sessionId: number, coachId: number) {
  const rows = await query<{ id: number }>('select id from session where id = $1 and coach_id = $2 and status <> \'cancelled\'', [sessionId, coachId]);
  return Boolean(rows[0]);
}
