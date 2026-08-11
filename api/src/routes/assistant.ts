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

/**
 * One assistant, built as a set of tools rather than a chain of ifs.
 *
 * Each tool declares who may call it and how well it fits a message. The
 * resolver scores every tool the caller is allowed to use and runs the best
 * match, so which tool answers is decided by the scores rather than by where a
 * branch happens to sit in the file. The previous long if-chain kept producing
 * the same defect: any phrasing nobody had anticipated fell past every branch
 * and landed on the catalogue, so a question about one session came back as a
 * list of twenty, and "my sessions" came back as everybody's.
 *
 * Two properties matter more than the routing and are preserved exactly:
 *
 *   1. `roles` is the access boundary. A tool the caller is not allowed to use
 *      is never scored, never selected and never run.
 *   2. Every tool runs its own query, already narrowed to the caller. Nothing
 *      is filtered after the fact, and a model only ever sees a finished
 *      answer. There is no prompt to talk around, because the data a caller is
 *      not entitled to is never fetched in the first place.
 */

type Audience = 'anonymous' | 'participant' | 'coach' | 'admin';

type AssistantReply = {
  answer: string;
  sessions?: unknown[];
  action?: { type: string; booking_id?: number };
};

type Ctx = {
  message: string;
  lower: string;
  user: CurrentUser | null;
  role: Audience;
  sessionId: number | null;
  discipline: string | null;
  emailInMessage: string | null;
  suppliedEmail?: string;
  /**
   * Resolved once per message, before scoring, because "cancel session 42" from
   * a coach means two different things depending on whether they teach it.
   */
  ownsSession: boolean;
};

type Tool = {
  name: string;
  /** Shown to a caller who asks what the assistant can do. */
  summary: string;
  roles: Audience[];
  /** 0 means "not this one". Higher wins; ties break on declaration order. */
  score: (ctx: Ctx) => number;
  run: (ctx: Ctx) => Promise<AssistantReply>;
};

// ---------------------------------------------------------------------------
// Reading the message
// ---------------------------------------------------------------------------

function sessionIdFrom(message: string): number | null {
  const match = message.match(/(?:session|booking|class)\s*#?\s*(\d+)/i) || message.match(/#(\d+)/);
  return match ? Number(match[1]) : null;
}

function moveTarget(message: string) {
  const match = message.match(/(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/);
  return match ? { date: match[1], time: match[2].padStart(5, '0') } : null;
}

/**
 * Disciplines come from the data, not from a list in this file. They were
 * hardcoded once and the list was missing `career`, 37 sessions that no
 * discipline filter could reach.
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
  return disciplines.find((d) => new RegExp(`\\b${escapeForRegex(d)}\\b`, 'i').test(message)) || null;
}

const hit = (ctx: Ctx, pattern: RegExp, weight = 1) => (pattern.test(ctx.lower) ? weight : 0);

const WANTS_ATTENDEES = /\b(who|whom|attending|attendee|attendees|roster|names|turned up|showed up)\b/;
const WANTS_CANCEL = /\b(cancel|cancelled|cancelling|drop|dropping|withdraw|give up|pull out)\b/;
const WANTS_BOOK = /\b(book|booking|reserve|enrol|enroll|sign me up|take a place|join)\b/;
const WANTS_MOVE = /\b(reschedule|move|shift|change the time|postpone)\b/;
const WANTS_BALANCE = /\b(balance|credits?|how much do i have)\b/;
const MINE = /\b(my|mine|i have|i'?m in|am i)\b/;

// ---------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------

async function publicCatalogue(discipline: string | null, withPlacesOnly: boolean) {
  const params: unknown[] = [];
  let filter = '';
  if (discipline) {
    params.push(discipline);
    filter = ` and s.discipline = $${params.length}`;
  }
  const rows = await query<any>(
    `select s.id, s.discipline, s.session_type, s.starts_at, s.ends_at, r.name as room_name,
            r.capacity,
            greatest(0, r.capacity - count(e.id) filter (where e.status = 'active')::int) as places_remaining,
            s.seat_fee_credits
       from session s join room r on r.id = s.room_id left join enrolment e on e.session_id = s.id
      where s.status <> 'cancelled' and s.starts_at >= now() and s.starts_at < now() + interval '14 days'${filter}
      group by s.id, r.id order by s.starts_at limit 40`,
    params
  );
  return (withPlacesOnly ? rows.filter((row) => Number(row.places_remaining) > 0) : rows).slice(0, 20);
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

const bookingLabel = (b: any) => `#${b.id} ${b.discipline} on ${centreDateTime(b.starts_at)} in ${b.room_name}`;

const row = (s: any) => ({
  id: s.id,
  discipline: s.discipline,
  session_type: s.session_type,
  starts_at: s.starts_at,
  ends_at: s.ends_at,
  room_name: s.room_name,
  capacity: Number(s.capacity),
  places_remaining: Number(s.places_remaining),
  seat_fee_credits: s.seat_fee_credits ?? 0
});

/** Does this coach own this session? Decides which "cancel session 42" was meant. */
async function coachOwns(sessionId: number, coachId: number): Promise<boolean> {
  const rows = await query<{ id: number }>('select id from session where id = $1 and coach_id = $2', [sessionId, coachId]);
  return Boolean(rows[0]);
}

const NOT_YOURS = 'I can only show participant-level details for your own sessions. Here is what is public about this one.';
const NOT_FOR_YOU =
  'I cannot tell you who is attending a session. Only the coach who runs it and an administrator see that. Here is what is public about it.';

/**
 * One session, described to whoever asked. Everything here is on the public
 * board, so it is safe for any caller. `refusal` leads the answer when the
 * caller asked for something they are not entitled to: returning the public
 * view in silence reads as the assistant misunderstanding rather than as a rule
 * being enforced.
 */
async function describeSession(sessionId: number, user: CurrentUser | null, refusal?: string): Promise<AssistantReply> {
  const rows = await query<any>(
    `select s.id, s.discipline, s.session_type, s.status, s.starts_at, s.ends_at, s.coach_id,
            r.name as room_name, r.capacity,
            greatest(0, r.capacity - count(e.id) filter (where e.status = 'active')::int) as places_remaining,
            s.seat_fee_credits
       from session s
       join room r on r.id = s.room_id
       left join enrolment e on e.session_id = s.id
      where s.id = $1
      group by s.id, r.id`,
    [sessionId]
  );

  const found = rows[0];
  if (!found) return { answer: `I cannot find a session numbered ${sessionId}.` };
  if (found.status === 'cancelled') {
    return { answer: `${refusal ? refusal + ' ' : ''}Session ${sessionId} (${found.discipline}) was cancelled, so it is no longer running.` };
  }

  const started = new Date(found.starts_at).getTime() <= Date.now();
  const lines: string[] = [];
  if (refusal) lines.push(refusal);
  lines.push(
    `Session ${sessionId}: ${found.discipline}, ${found.session_type}, on ${centreDateTime(found.starts_at)} in ${found.room_name}.`,
    started
      ? 'That one has already started.'
      : `${found.places_remaining} of ${found.capacity} places are still open, at ${found.seat_fee_credits} credits a place.`
  );

  if (user && user.kind !== 'admin') {
    const own = await query<{ status: string }>(
      'select status from enrolment where session_id = $1 and person_id = $2',
      [sessionId, user.id]
    );
    if (user.id === found.coach_id) {
      lines.push('You teach this one. Ask who is attending it and I will list the participants.');
    } else if (own[0]?.status === 'active') {
      lines.push('You already have a place on it.');
    } else if (!started && found.places_remaining > 0) {
      lines.push(`Say "book session ${sessionId}" and I will take the place from your account.`);
    }
  }

  return { answer: lines.join(' '), sessions: [row(found)] };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: 'help',
    summary: 'list what I can do',
    roles: ['anonymous', 'participant', 'coach', 'admin'],
    score: (ctx) => hit(ctx, /\b(help|what can you do|what do you do|how do i use|what can i ask|commands|options)\b/, 10),
    run: async (ctx) => ({ answer: helpText(ctx) })
  },

  {
    name: 'sign_in_first',
    summary: 'anything about your own account, once you have signed in',
    roles: ['anonymous'],
    // Without this, "my sessions" from a visitor scored as a catalogue question
    // and came back as everybody's sessions.
    score: (ctx) =>
      MINE.test(ctx.lower) && /\b(session|sessions|booking|bookings|balance|credits?|schedule|places?|account)\b/.test(ctx.lower) ? 6 : 0,
    run: async () => ({
      answer:
        'Sign in and I can show you your own bookings, your balance, and the sessions you teach if you are a coach. ' +
        'Signed out, I can only answer about the public schedule.'
    })
  },

  {
    name: 'reschedule_session',
    summary: 'move one of your sessions, taking every participant with it',
    roles: ['coach'],
    score: (ctx) => (ctx.sessionId && WANTS_MOVE.test(ctx.lower) ? 9 : 0),
    run: async (ctx) => {
      const target = moveTarget(ctx.message);
      if (!target) {
        return { answer: `Give me the new ${CENTRE_TIMEZONE} date and time, for example: move session ${ctx.sessionId} to 2026-08-20 14:00.` };
      }
      const rows = await query<any>(
        "select session_type from session where id = $1 and coach_id = $2 and status <> 'cancelled'",
        [ctx.sessionId, ctx.user!.id]
      );
      if (!rows[0]) return { answer: 'I can only move one of your own active sessions.' };
      try {
        const startsAt = centreInstant(target.date, target.time);
        const endsAt = new Date(new Date(startsAt).getTime() + sessionDurationMinutes(rows[0].session_type) * 60000).toISOString();
        await rescheduleSession(ctx.sessionId!, { id: ctx.user!.id, kind: 'coach' }, startsAt, endsAt);
        return {
          answer: `Session ${ctx.sessionId} moved to ${target.date} at ${target.time} ${CENTRE_TIMEZONE} time. Everyone enrolled moved with it and has been emailed.`,
          action: { type: 'session_rescheduled' }
        };
      } catch (err) {
        // The domain's own refusal, not one invented here, so the caller is told
        // exactly why the move was not allowed.
        if (err instanceof DomainError) return { answer: err.message };
        console.error(err);
        return { answer: 'I could not move that session.' };
      }
    }
  },

  {
    name: 'cancel_session',
    summary: 'cancel one of your sessions and refund everyone on it',
    roles: ['coach'],
    // A coach saying "cancel session 42" means one of two different things
    // depending on whether they teach it. Ownership decides, rather than the
    // wording, which used to send a coach's own booking cancellation into the
    // session-cancel path and fail with a permission error.
    score: (ctx) => (ctx.sessionId && WANTS_CANCEL.test(ctx.lower) && ctx.ownsSession ? 8 : 0),
    run: async (ctx) => {
      try {
        const summary = await cancelSession(ctx.sessionId!, { id: ctx.user!.id, kind: 'coach' });
        return {
          answer:
            `Session ${ctx.sessionId} is cancelled. ${summary.affected} participant(s) were refunded ` +
            `${summary.participantRefund} credits in full and emailed. You had ${Math.round(summary.refundPercent * 100)}% notice, ` +
            `so ${summary.coachRefund} credits of the room fee came back to you.`,
          action: { type: 'session_cancelled' }
        };
      } catch (err) {
        if (err instanceof DomainError) return { answer: err.message };
        console.error(err);
        return { answer: 'I could not cancel that session.' };
      }
    }
  },

  {
    name: 'book_place',
    summary: 'take a place in a session',
    roles: ['anonymous', 'participant', 'coach'],
    score: (ctx) => (WANTS_BOOK.test(ctx.lower) && !WANTS_CANCEL.test(ctx.lower) ? 7 : 0),
    run: async (ctx) => {
      if (!ctx.sessionId) {
        return { answer: 'Tell me the session number you want, for example "book session 123". Ask me what is running if you need one.' };
      }
      let personId = ctx.user?.id;
      let sendSetup = false;

      if (!personId) {
        const email = ctx.suppliedEmail?.trim().toLowerCase() || ctx.emailInMessage;
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return { answer: 'I can book that for you. Give me an email address and I will create your account and send a link to set a password.' };
        }
        const person = await createVisitorParticipant(email);
        // Booking onto an address that already has an account would let anyone
        // spend a stranger's credits by naming their email.
        if (!person.created) {
          return { answer: 'That email already has an Atrium account. Sign in first, so I cannot charge somebody else.' };
        }
        personId = person.id;
        sendSetup = true;
      }

      try {
        const booking = await bookSessionForPerson(personId!, ctx.sessionId);
        void notifyBooking(ctx.sessionId, personId!).catch(console.error);
        if (sendSetup) {
          const token = await createPasswordReset(personId!);
          const email = (ctx.suppliedEmail?.trim().toLowerCase() || ctx.emailInMessage)!;
          await sendPasswordSetup(email, token);
        }
        return {
          answer: `Booked session ${ctx.sessionId}, ${booking.credits_charged} credits. ${sendSetup ? 'I have emailed you a link to set your password. It lasts thirty minutes and works once.' : 'It is on your dashboard now.'}`,
          action: { type: 'booking_created', booking_id: booking.id }
        };
      } catch (err) {
        if (err instanceof DomainError) return { answer: err.message };
        console.error(err);
        return { answer: 'I could not complete that booking.' };
      }
    }
  },

  {
    name: 'cancel_booking',
    summary: 'give up a place you hold, with the refund the notice earns',
    roles: ['participant', 'coach'],
    score: (ctx) => (WANTS_CANCEL.test(ctx.lower) && !ctx.ownsSession ? 6 : 0),
    run: async (ctx) => {
      if (!ctx.sessionId) {
        const bookings = await activeBookingsFor(ctx.user!.id);
        if (!bookings.length) return { answer: 'You have no active upcoming bookings to cancel.' };
        return {
          answer:
            `Which one? You hold ${bookings.length} place(s):\n${bookings.map((b) => `· ${bookingLabel(b)}`).join('\n')}\n\n` +
            `Say "cancel session ${bookings[0].id}".`
        };
      }
      try {
        const result = await cancelBookingForPerson(ctx.user!.id, ctx.sessionId);
        return {
          answer:
            `Cancelled. You gave enough notice for a ${Math.round(result.refundPercent * 100)}% refund, ` +
            `so ${result.refund} credits went back to your account.`,
          action: { type: 'booking_cancelled' }
        };
      } catch (err) {
        if (err instanceof DomainError) {
          // A coach who neither holds a place nor teaches it would otherwise be
          // told only half of why there is nothing to cancel.
          const alsoNotYours = ctx.role === 'coach' ? ' You do not teach it either, so there is nothing of yours on it.' : '';
          return { answer: `${err.message}.${alsoNotYours}` };
        }
        console.error(err);
        return { answer: 'I could not cancel that booking.' };
      }
    }
  },

  {
    name: 'session_roster',
    summary: 'see who is booked on one of your sessions, who cancelled and who keeps turning up',
    roles: ['coach', 'admin'],
    score: (ctx) => (ctx.sessionId && WANTS_ATTENDEES.test(ctx.lower) ? 5 : 0),
    run: async (ctx) => {
      if (ctx.role === 'coach' && !ctx.ownsSession) return describeSession(ctx.sessionId!, ctx.user, NOT_YOURS);

      // Attendance comes from check_in, not from a booking count. A booking is
      // an intention; a check-in is what actually happened.
      const scopeToCoach = ctx.role === 'coach' ? ctx.user!.id : null;
      const rows = await query<any>(
        `select s.discipline, s.starts_at, s.status, r.name as room_name, r.capacity,
                coach.full_name as coach_name,
                p.full_name, p.email, e.status as booking_status, (c.id is not null) as attended,
                e.credits_charged, e.credits_refunded,
                (select count(*) from check_in c2
                   join enrolment e2 on e2.id = c2.enrolment_id
                   join session s2 on s2.id = e2.session_id
                  where e2.person_id = p.id and ($2::int is null or s2.coach_id = $2))::int as attendances,
                (select count(*) from enrolment e3
                   join session s3 on s3.id = e3.session_id
                  where e3.person_id = p.id and e3.status = 'cancelled'
                    and ($2::int is null or s3.coach_id = $2))::int as cancellations
           from session s
           join room r on r.id = s.room_id
           join person coach on coach.id = s.coach_id
           left join enrolment e on e.session_id = s.id
           left join person p on p.id = e.person_id
           left join check_in c on c.enrolment_id = e.id
          where s.id = $1
          order by p.full_name`,
        [ctx.sessionId, scopeToCoach]
      );

      if (!rows.length) return { answer: `There is no session numbered ${ctx.sessionId}.` };
      const head = rows[0];
      const people = rows.filter((r) => r.full_name);
      const header =
        `Session ${ctx.sessionId}: ${head.discipline} on ${centreDateTime(head.starts_at)} in ${head.room_name}` +
        `${ctx.role === 'admin' ? `, taught by ${head.coach_name}` : ''} (${head.status}).`;
      if (!people.length) return { answer: `${header} Nobody is enrolled yet.` };

      const lines = people.map((r) => {
        const state = r.booking_status === 'cancelled' ? 'cancelled' : r.attended ? 'attended' : 'booked';
        const who = ctx.role === 'admin' ? `${r.full_name} <${r.email}>` : r.full_name;
        const history = `${r.attendances} attendance(s), ${r.cancellations} cancellation(s)${ctx.role === 'coach' ? ' with you' : ''}`;
        const money = ctx.role === 'admin' ? `, charged ${r.credits_charged}${Number(r.credits_refunded) > 0 ? `, refunded ${r.credits_refunded}` : ''}` : '';
        return `${who}: ${state}, ${history}${money}`;
      });
      return { answer: `${header} ${people.length} of ${head.capacity} places:\n${lines.join('\n')}` };
    }
  },

  {
    name: 'person_lookup',
    summary: 'look up anyone by name or email, with their balance and activity',
    roles: ['admin'],
    score: (ctx) => (ctx.emailInMessage ? 5 : hit(ctx, /\b(balance|credits|account|record)\s+(of|for)\b/, 5)),
    run: async (ctx) => {
      const needle = ctx.emailInMessage || ctx.message.replace(/.*\b(?:balance|credits|account|record)\s+(?:of|for)\s+/i, '').trim();
      const rows = await query<any>(
        `select p.full_name, p.email, p.kind, p.credits, p.active,
                (select count(*) from enrolment e where e.person_id = p.id and e.status = 'active')::int as active_bookings,
                (select count(*) from session s where s.coach_id = p.id and s.status <> 'cancelled')::int as sessions_taught
           from person p
          where lower(p.email) = lower($1) or p.full_name ilike '%' || $1 || '%'
          order by p.full_name limit 5`,
        [needle]
      );
      if (!rows.length) return { answer: `I could not find anyone matching "${needle}".` };
      return {
        answer: rows
          .map(
            (r) =>
              `${r.full_name} <${r.email}>: ${r.kind}${r.active ? '' : ', inactive'}, ${r.credits} credits, ` +
              `${r.active_bookings} active booking(s), ${r.sessions_taught} session(s) taught`
          )
          .join('\n')
      };
    }
  },

  {
    name: 'centre_overview',
    summary: 'centre-wide totals across people, sessions and credits',
    roles: ['admin'],
    score: (ctx) => hit(ctx, /\b(overview|summary|stats?|statistics|how many|totals?|centre|center|people|users|members)\b/, 4),
    run: async () => {
      const [people, sessions, credits, upcoming] = await Promise.all([
        query<any>("select kind, count(*)::int as count from person where active = true group by kind order by kind"),
        query<any>('select status, count(*)::int as count from session group by status order by status'),
        query<any>('select coalesce(sum(credits), 0)::int as held from person where active = true'),
        query<any>(
          `select count(distinct s.id)::int as sessions,
                  count(distinct e.id) filter (where e.status = 'active')::int as places
             from session s left join enrolment e on e.session_id = s.id
            where s.status <> 'cancelled' and s.starts_at >= now() and s.starts_at < now() + interval '7 days'`
        )
      ]);
      const plural = (n: number, kind: string) => `${n} ${kind === 'coach' ? 'coaches' : kind + 's'}`;
      return {
        answer:
          `Active people: ${people.map((r) => plural(r.count, r.kind)).join(', ')}.\n` +
          `Sessions: ${sessions.map((r) => `${r.count} ${r.status}`).join(', ')}.\n` +
          `Next 7 days: ${upcoming[0].sessions} session(s), ${upcoming[0].places} place(s) taken.\n` +
          `Credits held across active accounts: ${credits[0].held}.`
      };
    }
  },

  {
    name: 'my_schedule',
    summary: 'the sessions you teach, upcoming or past',
    roles: ['coach'],
    score: (ctx) =>
      MINE.test(ctx.lower) && /\b(session|sessions|schedule|class|classes|calendar|diary|agenda|teach|teaching)\b/.test(ctx.lower) ? 4 : 0,
    run: async (ctx) => {
      const past = /\b(past|previous|earlier|history|finished|ran|last)\b/.test(ctx.lower);
      const rows = await query<any>(
        `select s.id, s.discipline, s.session_type, s.starts_at, s.ends_at, s.seat_fee_credits,
                r.name as room_name, r.capacity,
                count(e.id) filter (where e.status = 'active')::int as enrolled
           from session s
           join room r on r.id = s.room_id
           left join enrolment e on e.session_id = s.id
          where s.coach_id = $1 and s.status <> 'cancelled' and s.starts_at ${past ? '<' : '>='} now()
          group by s.id, r.id
          order by s.starts_at ${past ? 'desc' : 'asc'}
          limit 10`,
        [ctx.user!.id]
      );
      if (!rows.length) {
        return {
          answer: past
            ? 'You have no past sessions on record. Ask for your schedule and I will show what is coming up instead.'
            : 'You are not teaching anything in the schedule at the moment.'
        };
      }
      const taken = rows.reduce((sum: number, r: any) => sum + Number(r.enrolled), 0);
      return {
        answer:
          `You are teaching ${rows.length} ${past ? 'recent' : 'upcoming'} session(s), ${taken} place(s) taken across them. ` +
          `Times are ${CENTRE_TIMEZONE}. Ask who is attending any of them and I will list the participants.`,
        sessions: rows.map((r: any) => row({ ...r, places_remaining: Math.max(0, Number(r.capacity) - Number(r.enrolled)) }))
      };
    }
  },

  {
    name: 'my_bookings',
    summary: 'the places you hold',
    roles: ['participant', 'coach'],
    score: (ctx) => {
      if (WANTS_CANCEL.test(ctx.lower) || WANTS_BOOK.test(ctx.lower)) return 0;
      if (/\b(bookings?|reservations?|places?)\b/.test(ctx.lower)) return 3;
      // Coaches get "my sessions" routed to what they teach, above.
      return ctx.role === 'participant' && MINE.test(ctx.lower) && /\b(session|sessions|schedule|classes?|calendar|diary|agenda)\b/.test(ctx.lower) ? 3 : 0;
    },
    run: async (ctx) => {
      const bookings = await activeBookingsFor(ctx.user!.id);
      // "What is my balance and what are my bookings?" is one question with two
      // parts. Answering only the first reads as ignoring the rest.
      const alsoBalance = WANTS_BALANCE.test(ctx.lower) ? `Your balance is ${ctx.user!.credits} credits. ` : '';
      if (!bookings.length) return { answer: `${alsoBalance}You have no active upcoming bookings.` };
      return {
        answer: `${alsoBalance}You hold ${bookings.length} place(s):\n${bookings.map((b) => `· ${bookingLabel(b)}`).join('\n')}`
      };
    }
  },

  {
    name: 'my_balance',
    summary: 'your credit balance',
    roles: ['participant', 'coach', 'admin'],
    score: (ctx) => (WANTS_BALANCE.test(ctx.lower) ? 3 : 0),
    run: async (ctx) => ({ answer: `Your current balance is ${ctx.user!.credits} credits.` })
  },

  {
    name: 'session_detail',
    summary: 'what a session is, when, where, how many places are left and what it costs',
    roles: ['anonymous', 'participant', 'coach', 'admin'],
    score: (ctx) => (ctx.sessionId ? 2 : 0),
    run: async (ctx) => describeSession(ctx.sessionId!, ctx.user, WANTS_ATTENDEES.test(ctx.lower) ? NOT_FOR_YOU : undefined)
  },

  {
    name: 'catalogue',
    summary: 'what is running in the next fortnight, by discipline or by what still has places',
    roles: ['anonymous', 'participant', 'coach', 'admin'],
    score: (ctx) => {
      let s = 0;
      if (ctx.discipline) s += 2;
      s += hit(ctx, /\b(session|sessions|class|classes|timetable|schedule|running|upcoming|on offer|available|what'?s on)\b/, 2);
      s += hit(ctx, /\b(place|places|space|spaces|seat|seats|free|left|remaining|open|availab)\b/, 1);
      return s;
    },
    run: async (ctx) => {
      const placesOnly = /\b(place|places|space|spaces|seat|seats|free|left|remaining|open|availab)\b/.test(ctx.lower);
      const sessions = await publicCatalogue(ctx.discipline, placesOnly);
      const what = `${ctx.discipline ? ctx.discipline + ' ' : ''}session${sessions.length === 1 ? '' : 's'}${placesOnly ? ' with places left' : ''}`;

      if (!sessions.length) return { answer: `There are no ${what} in the next 14 days.` };

      const SHOWN = 8;
      const found =
        sessions.length > SHOWN
          ? `I found ${sessions.length} ${what} in the next 14 days. Here are the first ${SHOWN}, soonest first.`
          : `Here ${sessions.length === 1 ? 'is' : 'are'} the ${sessions.length} ${what} in the next 14 days.`;
      const next = ctx.user
        ? `Say "book session ${sessions[0].id}" and I will take the place from your account.`
        : `Say "book session ${sessions[0].id}" with your email address and I will create your account and send a password setup link.`;

      return { answer: `${found} Times are ${CENTRE_TIMEZONE}.\n\n${next}`, sessions: sessions.slice(0, SHOWN).map(row) };
    }
  }
];

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

function toolsFor(role: Audience) {
  return TOOLS.filter((tool) => tool.roles.includes(role));
}

function helpText(ctx: Ctx): string {
  const lines = toolsFor(ctx.role)
    .filter((tool) => tool.name !== 'help')
    .map((tool) => `· ${tool.summary}`);
  const who =
    ctx.role === 'anonymous'
      ? 'You are not signed in, so I can answer about the public schedule and take a booking against a new email address.'
      : `You are signed in as ${ctx.user!.full_name} (${ctx.role}).`;
  return `${who} I can:\n${lines.join('\n')}\n\nAsk in your own words. If I get it wrong, naming a session number usually helps.`;
}

async function buildContext(message: string, user: CurrentUser | null, suppliedEmail?: string): Promise<Ctx> {
  const role: Audience = user ? (user.kind as Audience) : 'anonymous';
  const sessionId = sessionIdFrom(message);
  return {
    message,
    lower: message.toLowerCase(),
    user,
    role,
    sessionId,
    discipline: await disciplineFrom(message),
    emailInMessage: message.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]?.toLowerCase() ?? null,
    suppliedEmail,
    ownsSession: Boolean(sessionId && user?.kind === 'coach' && (await coachOwns(sessionId, user.id)))
  };
}

async function replyForUser(message: string, user: CurrentUser | null, suppliedEmail?: string): Promise<AssistantReply> {
  const ctx = await buildContext(message, user, suppliedEmail);

  const ranked = toolsFor(ctx.role)
    .map((tool) => ({ tool, score: tool.score(ctx) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  // Nothing matched. Say so and show what is available, rather than dumping the
  // catalogue and hoping it was a catalogue question.
  if (!ranked.length) {
    return { answer: `I did not understand that one. ${helpText(ctx)}` };
  }

  return ranked[0].tool.run(ctx);
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
    // The model, if one is configured, only ever sees the finished answer.
    const answer = await polishAssistantAnswer({ role: user?.kind || 'anonymous', answer: result.answer, sessions: result.sessions });
    res.json({ ...result, answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'the assistant is temporarily unavailable' });
  }
});

export default router;
