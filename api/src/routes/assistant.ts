import { Router } from 'express';
import { createPasswordReset, getUserFromRequest, CurrentUser } from '../auth';
import { query } from '../db';
import { notifyBooking, sendPasswordSetup } from '../notifications';
import { bookSessionForPerson, cancelBookingForPerson, createVisitorParticipant } from '../services/bookings';
import { DomainError, cancelSession, rescheduleSession } from '../services/sessions';
import { sessionDurationMinutes } from '../credits';
import { CENTRE_TIMEZONE, centreDateTime, centreInstant } from '../domain';
import { polishAssistantAnswer } from '../assistantProvider';

const router = Router();

function sessionIdFrom(message: string): number | null {
  const match = message.match(/(?:session|booking)\s*#?\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function moveTarget(message: string) {
  const match = message.match(/(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/);
  return match ? { date: match[1], time: match[2].padStart(5, '0') } : null;
}

/**
 * Disciplines come from the data, not from a list in this file.
 *
 * They were hardcoded, and the list was missing `career` — 37 sessions that no
 * discipline filter could ever reach. Reading them from the database means a
 * discipline the centre adds tomorrow is searchable today.
 */
let disciplineCache: { values: string[]; readAt: number } = { values: [], readAt: 0 };
const DISCIPLINE_TTL_MS = 5 * 60 * 1000;

async function knownDisciplines(): Promise<string[]> {
  if (Date.now() - disciplineCache.readAt < DISCIPLINE_TTL_MS && disciplineCache.values.length) {
    return disciplineCache.values;
  }
  const rows = await query<{ discipline: string }>(
    "select distinct discipline from session where status <> 'cancelled' order by discipline"
  );
  disciplineCache = { values: rows.map((row) => row.discipline).filter(Boolean), readAt: Date.now() };
  return disciplineCache.values;
}

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function disciplineFrom(message: string): Promise<string | null> {
  const disciplines = await knownDisciplines();
  return disciplines.find((discipline) => new RegExp(`\\b${escapeForRegex(discipline)}\\b`, 'i').test(message)) || null;
}

/**
 * The catalogue tool. Anyone may call it, signed in or not — nothing it returns
 * is anyone's private information. Every other tool in this file narrows by the
 * caller before it reads, which is why filtering never has to happen afterwards.
 */
async function publicCatalogue(discipline: string | null = null, withPlacesOnly = false) {
  const params: unknown[] = [];
  let filter = '';
  if (discipline) {
    params.push(discipline);
    filter += ` and s.discipline = $${params.length}`;
  }
  const rows = await query<any>(
    `select s.id, s.discipline, s.session_type, s.starts_at, s.ends_at, r.name as room_name,
            r.capacity as capacity,
            count(e.id) filter (where e.status = 'active')::int as enrolled,
            greatest(0, r.capacity - count(e.id) filter (where e.status = 'active')::int) as places_remaining,
            s.seat_fee_credits
       from session s join room r on r.id = s.room_id left join enrolment e on e.session_id = s.id
      where s.status <> 'cancelled' and s.starts_at >= now() and s.starts_at < now() + interval '14 days'${filter}
      group by s.id, r.id order by s.starts_at limit 40`,
    params
  );
  const filtered = withPlacesOnly ? rows.filter((row) => Number(row.places_remaining) > 0) : rows;
  return filtered.slice(0, 20);
}

async function activeBookingsFor(personId: number) {
  return query<any>(
    `select s.id, s.discipline, s.starts_at, s.session_type, r.name as room_name
       from enrolment e
       join session s on s.id = e.session_id
       join room r on r.id = s.room_id
      where e.person_id = $1 and e.status = 'active'
        and s.status <> 'cancelled' and s.starts_at >= now()
      order by s.starts_at limit 10`,
    [personId]
  );
}

function bookingLabel(booking: any) {
  return `#${booking.id} ${booking.discipline} on ${centreDateTime(booking.starts_at)} in ${booking.room_name}`;
}

async function replyForUser(message: string, user: CurrentUser | null, email?: string) {
  const lower = message.toLowerCase();
  const sessionId = sessionIdFrom(message);

  if (user?.kind === 'coach' && sessionId && /(session|room)/.test(lower) && /(cancel|reschedule|move|shift)/.test(lower)) {
    if (/(reschedule|move|shift)/.test(lower)) {
      const target = moveTarget(message);
      if (!target) return { answer: 'Give me the new New York date and time, for example: move session 123 to 2026-08-20 14:00.' };
      try {
        const result = await query<any>('select session_type from session where id = $1 and coach_id = $2 and status <> \'cancelled\'', [sessionId, user.id]);
        if (!result[0]) return { answer: 'I can only move one of your active sessions.' };
        const startsAt = centreInstant(target.date, target.time);
        const endsAt = new Date(new Date(startsAt).getTime() + sessionDurationMinutes(result[0].session_type) * 60000).toISOString();
        await rescheduleSession(sessionId, { id: user.id, kind: user.kind }, startsAt, endsAt);
        return { answer: `Session ${sessionId} moved to ${target.date} at ${target.time} ${CENTRE_TIMEZONE} time. Everyone enrolled has been moved with it and notified.`, action: { type: 'session_rescheduled' } };
      } catch (err) {
        // The tool reports the domain's own refusal rather than inventing one:
        // the caller is told exactly why the move was not allowed.
        if (err instanceof DomainError) return { answer: err.message };
        console.error(err);
        return { answer: 'I could not move that session.' };
      }
    }
    try {
      const summary = await cancelSession(sessionId, { id: user.id, kind: user.kind });
      return {
        answer: `Session ${sessionId} cancelled. ${summary.affected} participant(s) were refunded ${summary.participantRefund} credits in full and notified. You received ${summary.coachRefund} credits back at ${Math.round(summary.refundPercent * 100)}% notice.`,
        action: { type: 'session_cancelled' }
      };
    } catch (err) {
      if (err instanceof DomainError) return { answer: err.message };
      console.error(err);
      return { answer: 'I could not cancel that session.' };
    }
  }

  if (/\b(book|reserve|enrol|enroll)\b/.test(lower)) {
    if (!sessionId) return { answer: 'Tell me the session number you want, for example “book session 123”.' };
    if (user?.kind === 'admin') return { answer: 'Administrators can manage sessions from the dashboard. I do not impersonate another person to charge a booking.' };
    let personId = user?.id;
    let passwordSetup = false;
    if (!personId) {
      const suppliedEmail = email?.trim().toLowerCase();
      if (!suppliedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(suppliedEmail)) {
        return { answer: 'I can book that for you. Please include an email address so Atrium can create your account and send a secure password setup link.' };
      }
      const person = await createVisitorParticipant(suppliedEmail);
      if (!person.created) return { answer: 'That email already has an Atrium account. Please sign in before booking so I cannot charge someone else’s account.' };
      personId = person.id;
      passwordSetup = true;
    }
    if (!personId) return { answer: 'I could not establish a safe account for that booking.' };
    try {
      const booking = await bookSessionForPerson(personId, sessionId);
      await notifyBooking(sessionId, personId);
      if (passwordSetup) {
        const setupToken = await createPasswordReset(personId);
        await sendPasswordSetup(email!.trim().toLowerCase(), setupToken);
      }
      return {
        answer: `Booked session ${sessionId}. ${passwordSetup ? 'I sent a secure password setup link to your email.' : 'The booking is now in your dashboard.'}`,
        action: { type: 'booking_created', booking_id: booking.id }
      };
    } catch (err) {
      if (err instanceof DomainError) return { answer: err.message };
      console.error(err);
      return { answer: 'I could not complete that booking.' };
    }
  }

  if (/\b(bookings?|reservations?)\b/.test(lower) && !/(cancel|drop)/.test(lower)) {
    if (!user) return { answer: 'Sign in to see your upcoming bookings.' };
    if (user.kind === 'admin') return { answer: 'Administrators do not have participant bookings. Use the session desk to manage sessions.' };
    const bookings = await activeBookingsFor(user.id);
    // "What is my balance and what are my bookings?" is one question with two
    // parts. Answering only the part that matched first reads as ignoring the
    // rest, so both are answered when both are asked.
    const alsoBalance = /(credit|balance)/.test(lower) ? `Your balance is ${user.credits} credits. ` : '';
    if (!bookings.length) return { answer: `${alsoBalance}You have no active upcoming bookings.` };
    return {
      answer: `${alsoBalance}You have ${bookings.length} active upcoming booking(s):\n${bookings.map((booking) => `· ${bookingLabel(booking)}`).join('\n')}`
    };
  }

  if (/(cancel|drop)/.test(lower)) {
    if (!user) return { answer: 'Sign in first so I can see your bookings. Then say “cancel session 123”.' };
    if (user.kind === 'admin') return { answer: 'Administrators do not have participant bookings. Use the session desk to manage sessions.' };
    const sessionId = sessionIdFrom(message);
    if (!sessionId) {
      const bookings = await activeBookingsFor(user.id);
      if (!bookings.length) return { answer: 'You have no active upcoming bookings to cancel.' };
      return { answer: `Your active bookings are: ${bookings.map(bookingLabel).join('; ')}. Tell me the session number to cancel, for example “cancel session ${bookings[0].id}”.` };
    }
    try {
      const result = await cancelBookingForPerson(user.id, sessionId);
      return {
        answer: `Booking cancelled. You gave enough notice for a ${Math.round(result.refundPercent * 100)}% refund, so ${result.refund} credits were returned to your account.`,
        action: { type: 'booking_cancelled' }
      };
    } catch (err) {
      if (err instanceof DomainError) return { answer: err.message };
      console.error(err);
      return { answer: 'I could not find an active booking for that session.' };
    }
  }

  // "My balance" only. A question about somebody else's balance is an
  // administrator question and is handled further down; matching it here would
  // answer with the caller's own figure, which is worse than refusing.
  if (/(credit|balance)/.test(lower) && !(user?.kind === 'admin' && /\b(of|for)\b|@/.test(lower))) {
    return user
      ? { answer: `Your current balance is ${user.credits} credits.` }
      : { answer: 'Sign in to see a personal credit balance.' };
  }

  if (user?.kind === 'coach' && /(attendee|attend|who is|cancelled|repeat)/.test(lower)) {
    const sessionId = sessionIdFrom(message);
    if (!sessionId) return { answer: 'Tell me the session number whose attendance you want to review.' };
    const session = await query<any>('select id, coach_id from session where id = $1', [sessionId]);
    if (!session[0] || session[0].coach_id !== user.id) return { answer: 'I can only show participant-level details for your own sessions.' };
    // "Who cancelled and who has attended repeatedly" is answered from the
    // attendance table, not from a booking count: a booking is an intention and
    // a check-in is what actually happened.
    const attendees = await query<any>(
      `select p.full_name, e.status, (c.id is not null) as attended,
              (select count(*) from check_in c2
                 join enrolment e2 on e2.id = c2.enrolment_id
                 join session s2 on s2.id = e2.session_id
                where e2.person_id = p.id and s2.coach_id = $2)::int as attended_with_you,
              (select count(*) from enrolment e3
                 join session s3 on s3.id = e3.session_id
                where e3.person_id = p.id and s3.coach_id = $2 and e3.status = 'cancelled')::int as cancelled_on_you
         from enrolment e
         join person p on p.id = e.person_id
         left join check_in c on c.enrolment_id = e.id
        where e.session_id = $1 order by p.full_name`,
      [sessionId, user.id]
    );
    if (!attendees.length) return { answer: 'There are no recorded enrolments for that session.' };
    const lines = attendees.map((row) => {
      const history = `${row.attended_with_you} attendance(s) and ${row.cancelled_on_you} cancellation(s) with you`;
      const state = row.status === 'cancelled' ? 'cancelled' : row.attended ? 'attended' : 'booked';
      return `${row.full_name} — ${state}, ${history}`;
    });
    return { answer: `Session ${sessionId} has ${attendees.length} recorded enrolment(s):\n${lines.join('\n')}` };
  }

  // An administrator sees everything, so their tools are the same shape as the
  // others with the ownership predicate removed — not a wider prompt.
  if (user?.kind === 'admin') {
    if (sessionId && /(attend|who|detail|enrol|enrol|roster)/.test(lower)) {
      const rows = await query<any>(
        `select s.discipline, s.starts_at, s.status, r.name as room_name, r.capacity,
                coach.full_name as coach_name,
                p.full_name, p.email, e.status as booking_status,
                e.credits_charged, e.credits_refunded, (c.id is not null) as attended
           from session s
           join room r on r.id = s.room_id
           join person coach on coach.id = s.coach_id
           left join enrolment e on e.session_id = s.id
           left join person p on p.id = e.person_id
           left join check_in c on c.enrolment_id = e.id
          where s.id = $1 order by p.full_name`,
        [sessionId]
      );
      if (!rows.length) return { answer: `There is no session ${sessionId}.` };
      const header = `Session ${sessionId}: ${rows[0].discipline} on ${centreDateTime(rows[0].starts_at)} in ${rows[0].room_name}, taught by ${rows[0].coach_name} (${rows[0].status}).`;
      const people = rows.filter((row) => row.full_name);
      if (!people.length) return { answer: `${header} Nobody is enrolled.` };
      const lines = people.map(
        (row) =>
          `${row.full_name} <${row.email}> — ${row.booking_status}` +
          `${row.attended ? ', attended' : ''}, charged ${row.credits_charged}` +
          `${Number(row.credits_refunded) > 0 ? `, refunded ${row.credits_refunded}` : ''}`
      );
      return { answer: `${header} ${people.length} of ${rows[0].capacity} places:\n${lines.join('\n')}` };
    }

    const emailMatch = message.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (emailMatch || /(balance|credits) (of|for)/.test(lower)) {
      const needle = emailMatch ? emailMatch[0] : message.replace(/.*(?:balance|credits)\s+(?:of|for)\s+/i, '').trim();
      const rows = await query<any>(
        `select p.id, p.full_name, p.email, p.kind, p.credits, p.active,
                (select count(*) from enrolment e where e.person_id = p.id and e.status = 'active')::int as active_bookings,
                (select count(*) from session s where s.coach_id = p.id and s.status <> 'cancelled')::int as sessions_taught
           from person p
          where lower(p.email) = lower($1) or p.full_name ilike '%' || $1 || '%'
          order by p.full_name limit 5`,
        [needle]
      );
      if (!rows.length) return { answer: `I could not find anyone matching “${needle}”.` };
      return {
        answer: rows
          .map(
            (row) =>
              `${row.full_name} <${row.email}> — ${row.kind}${row.active ? '' : ', inactive'}, ` +
              `${row.credits} credits, ${row.active_bookings} active booking(s), ${row.sessions_taught} session(s) taught`
          )
          .join('\n')
      };
    }

    if (/(people|users|members|overview|stat|how many|summary|centre|center)/.test(lower)) {
      const [people, sessions, credits] = await Promise.all([
        query<any>('select kind, count(*)::int as count from person where active = true group by kind order by kind'),
        query<any>(`select status, count(*)::int as count from session group by status order by status`),
        query<any>(`select coalesce(sum(credits), 0)::int as held from person where active = true`)
      ]);
      const upcoming = await query<any>(
        `select count(*)::int as sessions,
                count(distinct e.id) filter (where e.status = 'active')::int as places
           from session s left join enrolment e on e.session_id = s.id
          where s.status <> 'cancelled' and s.starts_at >= now() and s.starts_at < now() + interval '7 days'`
      );
      const plural = (count: number, kind: string) => `${count} ${kind === 'coach' ? 'coaches' : kind + 's'}`;
      return {
        answer:
          `Active people: ${people.map((row) => plural(row.count, row.kind)).join(', ')}.\n` +
          `Sessions: ${sessions.map((row) => `${row.count} ${row.status}`).join(', ')}.\n` +
          `Next 7 days: ${upcoming[0].sessions} session(s) with ${upcoming[0].places} place(s) taken.\n` +
          `Credits held across active accounts: ${credits[0].held}.`
      };
    }
  }

  const discipline = await disciplineFrom(message);
  // "What has places left?" is a different question from "what is running?", and
  // the catalogue answers both rather than treating every question as the same.
  const placesOnly = /\b(place|places|space|spaces|seat|seats|availab|free|left|remaining|open)\b/.test(lower);
  const sessions = await publicCatalogue(discipline, placesOnly);

  if (!sessions.length) {
    const nothing = discipline
      ? `There are no ${discipline} sessions${placesOnly ? ' with places left' : ''} in the next 14 days.`
      : `There are no upcoming sessions${placesOnly ? ' with places left' : ''} in the next 14 days.`;
    return { answer: nothing };
  }

  // The prose says what was found; the rows below it say what they are. Putting
  // the listing in both places gave the panel the same information twice, once
  // as a wall of text and once as a table.
  const SHOWN = 8;
  const subject = `${discipline ? discipline + ' ' : ''}session${sessions.length === 1 ? '' : 's'}`;
  const found =
    sessions.length > SHOWN
      ? `I found ${sessions.length} ${subject}${placesOnly ? ' with places left' : ''} in the next 14 days. Here are the first ${SHOWN}, soonest first.`
      : `Here ${sessions.length === 1 ? 'is' : 'are'} the ${sessions.length} ${subject}${placesOnly ? ' with places left' : ''} in the next 14 days.`;
  const next = user
    ? `Say “book session ${sessions[0].id}” and I will take the place from your account.`
    : `Say “book session ${sessions[0].id}” with your email address and I will create your account and send a password setup link.`;

  return {
    answer: `${found} Times are ${CENTRE_TIMEZONE}.\n\n${next}`,
    sessions: sessions.slice(0, SHOWN).map((session) => ({
      id: session.id,
      discipline: session.discipline,
      session_type: session.session_type,
      starts_at: session.starts_at,
      ends_at: session.ends_at,
      room_name: session.room_name,
      capacity: Number(session.capacity),
      places_remaining: Number(session.places_remaining),
      seat_fee_credits: session.seat_fee_credits
    }))
  };
}

router.post('/', async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const user = await getUserFromRequest(req);
    const result = await replyForUser(message, user, typeof req.body?.email === 'string' ? req.body.email : undefined);
    const answer = await polishAssistantAnswer({ role: user?.kind || 'anonymous', answer: result.answer, sessions: result.sessions });
    res.json({ ...result, answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'the assistant is temporarily unavailable' });
  }
});

export default router;
