import cron from 'node-cron';
import { query } from './db';
import { sendMail } from './notifications';
import { CENTRE_TIMEZONE, centreClock, centreDayWindow } from './domain';
import { completeFinishedSessions } from './services/sessions';

/**
 * Both digests run at 00:00 centre-local time and report on the local day that
 * has just begun.
 *
 * Two things have to be right for that to hold across a daylight-saving change.
 * The cron expression is registered with the centre timezone, so the job fires
 * at local midnight rather than at a fixed UTC hour, because a UTC-anchored job would
 * start firing at 23:00 local after 1 November 2026. And the window is built
 * from one local midnight to the *next* local midnight rather than by adding 24
 * hours, because the local day is 25 hours long on 1 November and 23 hours long
 * on 8 March. See `centreDayWindow` in domain.ts.
 */

export async function sendDailyDigests(now = new Date()): Promise<void> {
  const window = centreDayWindow(now);

  const coaches = await query<{ id: number; email: string; full_name: string }>(
    "select id, email, full_name from person where kind = 'coach' and active = true"
  );

  for (const coach of coaches) {
    // A coach's day covers what they teach and what they attend: both are
    // commitments they need to see the night before.
    const sessions = await query<any>(
      `select s.discipline, s.starts_at, s.ends_at, r.name as room_name,
              (s.coach_id = $1) as teaching,
              count(e.id) filter (where e.status = 'active')::int as attendees
         from session s
         join room r on r.id = s.room_id
         left join enrolment e on e.session_id = s.id
        where s.status <> 'cancelled'
          and s.starts_at >= $2 and s.starts_at < $3
          and (s.coach_id = $1 or exists (
            select 1 from enrolment me
             where me.session_id = s.id and me.person_id = $1 and me.status = 'active'
          ))
        group by s.id, r.id
        order by s.starts_at`,
      [coach.id, window.from, window.to]
    );

    // A coach with nothing on receives no email at all.
    if (!sessions.length) continue;

    await sendMail({
      to: coach.email,
      subject: `Your Atrium day: ${window.date}`,
      text:
        `Sessions for ${window.date} (${CENTRE_TIMEZONE}):\n\n` +
        sessions
          .map(
            (session) =>
              `${centreClock(session.starts_at)}–${centreClock(session.ends_at)}  ${session.discipline} in ${session.room_name}` +
              (session.teaching ? ` (teaching, ${session.attendees} attendee(s))` : ' (attending)')
          )
          .join('\n')
    });
  }

  const digest = await query<any>(
    `select s.discipline, s.starts_at, s.ends_at, r.name as room_name, p.full_name as coach_name,
            count(e.id) filter (where e.status = 'active')::int as attendees
       from session s
       join room r on r.id = s.room_id
       join person p on p.id = s.coach_id
       left join enrolment e on e.session_id = s.id
      where s.status <> 'cancelled' and s.starts_at >= $1 and s.starts_at < $2
      group by s.id, r.id, p.id
      order by s.starts_at`,
    [window.from, window.to]
  );

  const totalAttendances = digest.reduce((sum: number, row: any) => sum + Number(row.attendees), 0);
  const admins = await query<{ email: string }>("select email from person where kind = 'admin' and active = true");

  for (const admin of admins) {
    await sendMail({
      to: admin.email,
      subject: `Atrium daily digest: ${window.date}`,
      text: digest.length
        ? `${digest.length} session(s) and ${totalAttendances} attendance(s) for ${window.date} (${CENTRE_TIMEZONE}):\n\n` +
          digest
            .map(
              (row: any) =>
                `${centreClock(row.starts_at)}–${centreClock(row.ends_at)}  ${row.discipline} · ${row.room_name} · ${row.coach_name} · ${row.attendees} attendee(s)`
            )
            .join('\n')
        : `No sessions are scheduled for ${window.date}.`
    });
  }
}

export function startScheduler(): void {
  if (process.env.SCHEDULER_ENABLED !== 'true') {
    console.log('scheduler disabled (set SCHEDULER_ENABLED=true to run the nightly jobs)');
    return;
  }

  cron.schedule('0 0 * * *', () => void sendDailyDigests().catch(console.error), { timezone: CENTRE_TIMEZONE });

  // Sessions that have finished stop being 'scheduled'. Runs hourly rather than
  // nightly so the public board does not advertise a session that ended an hour
  // ago as still upcoming.
  cron.schedule(
    '5 * * * *',
    () =>
      void completeFinishedSessions()
        .then((count) => count && console.log(`marked ${count} finished session(s) as completed`))
        .catch(console.error),
    { timezone: CENTRE_TIMEZONE }
  );

  console.log(`scheduler enabled: digests at 00:00 ${CENTRE_TIMEZONE}, session close-out hourly`);
}
