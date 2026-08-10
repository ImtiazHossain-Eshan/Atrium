import { Router } from 'express';
import { createPasswordReset, getUserFromRequest, CurrentUser } from '../auth';
import { query } from '../db';
import { notifyBooking, sendPasswordSetup } from '../notifications';
import { bookSessionForPerson, cancelBookingForPerson, createVisitorParticipant } from '../services/bookings';
import { cancelSessionForCoach, rescheduleSessionForCoach } from '../services/sessions';
import { polishAssistantAnswer } from '../assistantProvider';

const router = Router();

function sessionIdFrom(message: string): number | null {
  const match = message.match(/(?:session|booking)\s*#?\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function zoneOffset(date: Date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(date).find((item) => item.type === 'timeZoneName')?.value || 'GMT';
  const match = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] || 0)) * 60000;
}

function centreIso(date: string, time: string) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(naive.getTime() - zoneOffset(naive)).toISOString();
}

function moveTarget(message: string) {
  const match = message.match(/(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/);
  return match ? { date: match[1], time: match[2].padStart(5, '0') } : null;
}

const assistantDisciplines = ['fitness', 'mindfulness', 'financial', 'lifestyle'] as const;

function disciplineFrom(message: string) {
  return assistantDisciplines.find((discipline) => new RegExp(`\\b${discipline}\\b`, 'i').test(message)) || null;
}

async function publicCatalogue(discipline: string | null = null) {
  const disciplineFilter = discipline ? ' and s.discipline = $1' : '';
  const params = discipline ? [discipline] : [];
  return query<any>(
    `select s.id, s.discipline, s.session_type, s.starts_at, s.ends_at, r.name as room_name,
            r.capacity - count(e.id) filter (where e.status = 'active')::int as places_remaining,
            s.seat_fee_credits
       from session s join room r on r.id = s.room_id left join enrolment e on e.session_id = s.id
      where s.status <> 'cancelled' and s.starts_at >= now() and s.starts_at < now() + interval '14 days'${disciplineFilter}
      group by s.id, r.id order by s.starts_at limit 20`,
    params
  );
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
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(booking.starts_at));
  return `#${booking.id} ${booking.discipline} on ${when} in ${booking.room_name}`;
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
        const minutes = result[0].session_type === 'short' ? 45 : result[0].session_type === 'intensive' ? 210 : 60;
        const startsAt = centreIso(target.date, target.time);
        const endsAt = new Date(new Date(startsAt).getTime() + minutes * 60000).toISOString();
        await rescheduleSessionForCoach(sessionId, user.id, startsAt, endsAt);
        return { answer: `Session ${sessionId} moved to ${target.date} at ${target.time} New York time. Enrolled attendees were notified.`, action: { type: 'session_rescheduled' } };
      } catch (err) {
        const reason = err instanceof Error ? err.message : '';
        return { answer: reason === 'room_conflict' ? 'That room is already booked at the new time.' : reason === 'person_conflict' ? 'You already have another commitment at the new time.' : 'I could not move that session.' };
      }
    }
    try {
      await cancelSessionForCoach(sessionId, user.id);
      return { answer: `Session ${sessionId} cancelled. Enrolled participants were fully refunded and notified.`, action: { type: 'session_cancelled' } };
    } catch (err) {
      return { answer: err instanceof Error && err.message === 'forbidden' ? 'I can only cancel one of your own sessions.' : 'I could not cancel that session.' };
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
      const bookingError = err instanceof Error ? err.message : '';
      const responses: Record<string, string> = {
        not_found: 'That session is not available.',
        own_session: 'A coach cannot book their own session.',
        past_session: 'That session has already started.',
        already_booked: 'You already have an active booking for that session.',
        full: 'That session is full.',
        person_conflict: 'You already have another commitment during that interval.',
        insufficient_credits: 'There are not enough credits on the account for that place.'
      };
      return { answer: responses[bookingError] || 'I could not complete that booking.' };
    }
  }

  if (/\b(bookings?|reservations?)\b/.test(lower) && !/(cancel|drop)/.test(lower)) {
    if (!user) return { answer: 'Sign in to see your upcoming bookings.' };
    if (user.kind === 'admin') return { answer: 'Administrators do not have participant bookings. Use the session desk to manage sessions.' };
    const bookings = await activeBookingsFor(user.id);
    if (!bookings.length) return { answer: 'You have no active upcoming bookings.' };
    return { answer: `Your active bookings are: ${bookings.map(bookingLabel).join('; ')}.` };
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
      return { answer: `Booking cancelled. The account received ${result.refund} credits under the published cancellation policy.`, action: { type: 'booking_cancelled' } };
    } catch (err) {
      return { answer: err instanceof Error && err.message === 'session_cancelled' ? 'That session was cancelled by the coach; the full place fee has already been refunded.' : 'I could not find an active booking for that session.' };
    }
  }

  if (/(credit|balance)/.test(lower)) return user ? { answer: `Your current balance is ${user.credits} credits.` } : { answer: 'Sign in to see a personal credit balance.' };

  if (user?.kind === 'coach' && /(attendee|attend|who is|cancelled|repeat)/.test(lower)) {
    const sessionId = sessionIdFrom(message);
    if (!sessionId) return { answer: 'Tell me the session number whose attendance you want to review.' };
    const session = await query<any>('select id, coach_id from session where id = $1', [sessionId]);
    if (!session[0] || session[0].coach_id !== user.id) return { answer: 'I can only show participant-level details for your own sessions.' };
    const attendees = await query<any>(
      `select p.full_name, e.status,
              (select count(*) from enrolment e2 where e2.person_id = p.id and e2.status = 'active')::int as active_bookings
         from enrolment e join person p on p.id = e.person_id where e.session_id = $1 order by e.id`,
      [sessionId]
    );
    return { answer: attendees.length ? `Session ${sessionId} has ${attendees.length} recorded enrolments. ${attendees.map((row) => `${row.full_name} (${row.status})`).join(', ')}.` : 'There are no recorded enrolments for that session.' };
  }

  if (user?.kind === 'admin' && /(people|users|attendance|overview)/.test(lower)) {
    const rows = await query<any>(`select kind, count(*)::int as count from person where active = true group by kind order by kind`);
    return { answer: `The centre currently has ${rows.map((row) => `${row.count} ${row.kind}s`).join(', ')}.` };
  }

  const discipline = disciplineFrom(message);
  const sessions = await publicCatalogue(discipline);
  if (!sessions.length) return { answer: 'There are no upcoming sessions in the next 14 days.' };
  return {
    answer: `I found ${sessions.length} upcoming sessions. Ask about a discipline, or say “book session ${sessions[0].id}”${user ? '' : ' with an email address'}.`,
    sessions: sessions.map((session) => ({ id: session.id, discipline: session.discipline, session_type: session.session_type, starts_at: session.starts_at, ends_at: session.ends_at, room_name: session.room_name, places_remaining: Number(session.places_remaining), seat_fee_credits: session.seat_fee_credits }))
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
