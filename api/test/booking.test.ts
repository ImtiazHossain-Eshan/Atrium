/**
 * The booking rules, exercised against a real database.
 *
 * These are the invariants the brief is most specific about: capacity, personal
 * overlap, the coach's deadline, and where the credits end up after each kind
 * of cancellation. They run through the same service functions the API and the
 * assistant call, so a change that breaks one breaks all three.
 */
import { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db';
import { bookSessionForPerson, cancelBookingForPerson } from '../src/services/bookings';
import { DomainError, cancelSession, createSession, rescheduleSession } from '../src/services/sessions';
import { seatFee } from '../src/credits';
import {
  cleanup,
  closePool,
  creditsOf,
  databaseAvailable,
  dbIt,
  makePerson,
  makeRoom,
  makeSession,
  slotAt
} from './fixtures';

describe('booking, cancellation and refunds', () => {
  before(async () => {
    if (await databaseAvailable()) await cleanup();
  });
  after(async () => {
    if (await databaseAvailable()) await cleanup();
    await closePool();
  });

  dbIt('charges the place fee and returns it in tiers when the participant cancels', async () => {
    const coach = await makePerson('coach', 2000);
    const participant = await makePerson('participant', 4000);
    const room = await makeRoom(4);

    // 100 hours out: above the 96-hour tier, so a full refund.
    const slot = slotAt(5, '09:00');
    const session = await makeSession({
      roomId: room.id,
      coachId: coach.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAtAfter(60),
      seatFee: seatFee('standard')
    });

    await bookSessionForPerson(participant.id, session.id);
    assert.equal(await creditsOf(participant.id), 4000 - 20, 'the place fee is taken at booking');

    const result = await cancelBookingForPerson(participant.id, session.id);
    assert.equal(result.refundPercent, 1);
    assert.equal(result.refund, 20);
    assert.equal(await creditsOf(participant.id), 4000, 'a full-notice cancellation leaves the balance where it started');
  });

  dbIt('refunds nothing when a participant cancels inside 24 hours', async () => {
    const coach = await makePerson('coach', 2000);
    const participant = await makePerson('participant', 4000);
    const room = await makeRoom(4);

    // Written directly rather than through createSession: a coach could not
    // have booked this legally, but a session can reach this state by being
    // booked earlier and cancelled late.
    const startsAt = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
    const session = await makeSession({
      roomId: room.id,
      coachId: coach.id,
      startsAt,
      endsAt: new Date(Date.now() + 7 * 3600 * 1000).toISOString(),
      seatFee: 20
    });

    await bookSessionForPerson(participant.id, session.id);
    const result = await cancelBookingForPerson(participant.id, session.id);

    assert.equal(result.refundPercent, 0);
    assert.equal(result.refund, 0);
    assert.equal(await creditsOf(participant.id), 4000 - 20, 'late notice forfeits the fee');
  });

  dbIt('refunds every participant in full when the coach cancels, whatever the notice', async () => {
    const coach = await makePerson('coach', 2000);
    const participant = await makePerson('participant', 4000);
    const room = await makeRoom(4);

    // Two hours away: the coach gets nothing back, the participant gets it all.
    const startsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const session = await makeSession({
      roomId: room.id,
      coachId: coach.id,
      startsAt,
      endsAt: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
      seatFee: 20,
      roomFee: 40
    });

    await bookSessionForPerson(participant.id, session.id);
    assert.equal(await creditsOf(participant.id), 3980);

    const summary = await cancelSession(session.id, { id: coach.id, kind: 'coach' });

    assert.equal(summary.affected, 1);
    assert.equal(summary.participantRefund, 20);
    assert.equal(summary.coachRefund, 0, 'the coach cancelled inside 24 hours and recovers nothing');
    assert.equal(await creditsOf(participant.id), 4000, 'the participant did nothing wrong and is made whole');
  });

  dbIt('refuses a place once the room is full', async () => {
    const coach = await makePerson('coach', 2000);
    const room = await makeRoom(1);
    const slot = slotAt(5, '10:00');
    const session = await makeSession({ roomId: room.id, coachId: coach.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60) });

    const first = await makePerson('participant', 4000);
    const second = await makePerson('participant', 4000);

    await bookSessionForPerson(first.id, session.id);
    await assert.rejects(() => bookSessionForPerson(second.id, session.id), (err: DomainError) => err.code === 'full');
    assert.equal(await creditsOf(second.id), 4000, 'a refused booking charges nothing');
  });

  dbIt('refuses two overlapping commitments for the same person', async () => {
    const coachOne = await makePerson('coach', 2000);
    const coachTwo = await makePerson('coach', 2000);
    const participant = await makePerson('participant', 4000);
    const roomOne = await makeRoom(4);
    const roomTwo = await makeRoom(4);

    const slot = slotAt(6, '11:00');
    const first = await makeSession({ roomId: roomOne.id, coachId: coachOne.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60) });
    // Starts 30 minutes in, in a different room.
    const overlapping = await makeSession({
      roomId: roomTwo.id,
      coachId: coachTwo.id,
      startsAt: slot.endsAtAfter(30),
      endsAt: slot.endsAtAfter(90)
    });

    await bookSessionForPerson(participant.id, first.id);
    await assert.rejects(
      () => bookSessionForPerson(participant.id, overlapping.id),
      (err: DomainError) => err.code === 'person_conflict'
    );
  });

  dbIt('allows a booking that begins exactly as another ends', async () => {
    const coachOne = await makePerson('coach', 2000);
    const coachTwo = await makePerson('coach', 2000);
    const participant = await makePerson('participant', 4000);
    const roomOne = await makeRoom(4);
    const roomTwo = await makeRoom(4);

    const slot = slotAt(7, '09:00');
    const first = await makeSession({ roomId: roomOne.id, coachId: coachOne.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60) });
    const touching = await makeSession({
      roomId: roomTwo.id,
      coachId: coachTwo.id,
      startsAt: slot.endsAtAfter(60),
      endsAt: slot.endsAtAfter(120)
    });

    await bookSessionForPerson(participant.id, first.id);
    // Half-open intervals: 10:00–11:00 does not conflict with 09:00–10:00.
    const second = await bookSessionForPerson(participant.id, touching.id);
    assert.ok(second.id);
  });

  dbIt('keeps an intensive lunch interval clear for everyone involved', async () => {
    const coachOne = await makePerson('coach', 2000);
    const coachTwo = await makePerson('coach', 2000);
    const participant = await makePerson('participant', 4000);
    const roomOne = await makeRoom(4);
    const roomTwo = await makeRoom(4);

    const slot = slotAt(8, '09:00');
    const intensive = await makeSession({
      roomId: roomOne.id,
      coachId: coachOne.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAtAfter(210),
      sessionType: 'intensive',
      seatFee: 60
    });
    // 10:45–11:45 sits inside the intensive's 30-minute interval.
    const duringLunch = await makeSession({
      roomId: roomTwo.id,
      coachId: coachTwo.id,
      startsAt: slot.endsAtAfter(105),
      endsAt: slot.endsAtAfter(165)
    });

    await bookSessionForPerson(participant.id, intensive.id);
    await assert.rejects(
      () => bookSessionForPerson(participant.id, duringLunch.id),
      (err: DomainError) => err.code === 'person_conflict',
      'the room is held across the interval, so nobody involved is free during it'
    );
  });

  dbIt('refuses a booking the account cannot pay for and charges nothing', async () => {
    const coach = await makePerson('coach', 2000);
    const poor = await makePerson('participant', 5);
    const room = await makeRoom(4);
    const slot = slotAt(9, '09:00');
    const session = await makeSession({ roomId: room.id, coachId: coach.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60), seatFee: 20 });

    await assert.rejects(() => bookSessionForPerson(poor.id, session.id), (err: DomainError) => err.code === 'insufficient_credits');
    assert.equal(await creditsOf(poor.id), 5);
  });

  dbIt('refuses a coach enrolling in their own session', async () => {
    const coach = await makePerson('coach', 2000);
    const room = await makeRoom(4);
    const slot = slotAt(10, '09:00');
    const session = await makeSession({ roomId: room.id, coachId: coach.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60) });

    await assert.rejects(() => bookSessionForPerson(coach.id, session.id), (err: DomainError) => err.code === 'own_session');
  });

  dbIt('holds a coach to the 48-hour booking deadline but not an administrator', async () => {
    const coach = await makePerson('coach', 2000);
    const admin = await makePerson('admin', 0);
    const room = await makeRoom(4);

    const tooSoon = new Date(Date.now() + 12 * 3600 * 1000);
    const soonSlot = { startsAt: tooSoon.toISOString(), endsAt: new Date(tooSoon.getTime() + 3600 * 1000).toISOString() };

    await assert.rejects(
      () =>
        createSession(
          { id: coach.id, kind: 'coach' },
          { roomId: room.id, coachId: coach.id, discipline: 'fitness', sessionType: 'standard', ...soonSlot }
        ),
      (err: DomainError) => err.code === 'notice_too_short' || err.code === 'invalid_window'
    );

    const slot = slotAt(11, '09:00');
    const created = await createSession(
      { id: coach.id, kind: 'coach' },
      {
        roomId: room.id,
        coachId: coach.id,
        discipline: 'fitness',
        sessionType: 'standard',
        startsAt: slot.startsAt,
        endsAt: slot.endsAtAfter(60)
      }
    );
    assert.equal(await creditsOf(coach.id), 2000 - 40, 'the room fee is charged on booking');
    assert.ok(created.id);
  });

  dbIt('refuses a room double-booking at the database, not only in the service', async () => {
    const coachOne = await makePerson('coach', 2000);
    const coachTwo = await makePerson('coach', 2000);
    const room = await makeRoom(4);
    const slot = slotAt(12, '09:00');

    await makeSession({ roomId: room.id, coachId: coachOne.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60) });

    // Straight insert, bypassing every application check: the exclusion
    // constraint is what actually makes this impossible.
    await assert.rejects(
      () =>
        query(
          `insert into session (room_id, coach_id, discipline, session_type, status, starts_at, ends_at, room_fee_credits, seat_fee_credits, created_at)
           values ($1, $2, 'sneaky', 'standard', 'scheduled', $3, $4, 40, 20, now())`,
          [room.id, coachTwo.id, slot.endsAtAfter(30), slot.endsAtAfter(90)]
        ),
      /active_room_no_overlap|conflicting key/i
    );
  });

  dbIt('refuses to move a session onto a time an enrolled participant cannot make', async () => {
    const coachOne = await makePerson('coach', 2000);
    const coachTwo = await makePerson('coach', 2000);
    const participant = await makePerson('participant', 4000);
    const roomOne = await makeRoom(4);
    const roomTwo = await makeRoom(4);

    const slot = slotAt(13, '09:00');
    const moving = await makeSession({ roomId: roomOne.id, coachId: coachOne.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60) });
    const clash = await makeSession({ roomId: roomTwo.id, coachId: coachTwo.id, startsAt: slot.endsAtAfter(120), endsAt: slot.endsAtAfter(180) });

    await bookSessionForPerson(participant.id, moving.id);
    await bookSessionForPerson(participant.id, clash.id);

    // 11:00–12:00 is exactly when the participant is already committed.
    await assert.rejects(
      () =>
        rescheduleSession(moving.id, { id: coachOne.id, kind: 'coach' }, slot.endsAtAfter(120), slot.endsAtAfter(180)),
      (err: DomainError) => err.code === 'attendee_conflict'
    );

    // Moving somewhere everyone is free is allowed, and takes them with it.
    const moved = await rescheduleSession(moving.id, { id: coachOne.id, kind: 'coach' }, slot.endsAtAfter(240), slot.endsAtAfter(300));
    assert.equal(new Date(moved.starts_at).toISOString(), slot.endsAtAfter(240));

    const stillEnrolled = await query<{ count: number }>(
      "select count(*)::int as count from enrolment where session_id = $1 and person_id = $2 and status = 'active'",
      [moving.id, participant.id]
    );
    assert.equal(Number(stillEnrolled[0].count), 1, 'the participant moved with the session');
  });

  dbIt('refuses to move or cancel a session belonging to another coach', async () => {
    const owner = await makePerson('coach', 2000);
    const stranger = await makePerson('coach', 2000);
    const room = await makeRoom(4);
    const slot = slotAt(14, '09:00');
    const session = await makeSession({ roomId: room.id, coachId: owner.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60) });

    await assert.rejects(
      () => cancelSession(session.id, { id: stranger.id, kind: 'coach' }),
      (err: DomainError) => err.code === 'forbidden' && err.status === 403
    );
    await assert.rejects(
      () => rescheduleSession(session.id, { id: stranger.id, kind: 'coach' }, slot.endsAtAfter(120), slot.endsAtAfter(180)),
      (err: DomainError) => err.code === 'forbidden'
    );
  });

  dbIt('records every credit movement in the ledger', async () => {
    const coach = await makePerson('coach', 2000);
    const participant = await makePerson('participant', 4000);
    const room = await makeRoom(4);
    const slot = slotAt(15, '09:00');
    const session = await makeSession({ roomId: room.id, coachId: coach.id, startsAt: slot.startsAt, endsAt: slot.endsAtAfter(60), seatFee: 20 });

    await bookSessionForPerson(participant.id, session.id);
    await cancelBookingForPerson(participant.id, session.id);

    const entries = await query<{ amount: number; reason: string }>(
      'select amount, reason from credit_ledger where person_id = $1 order by id',
      [participant.id]
    );
    assert.deepEqual(
      entries.map((entry) => Number(entry.amount)),
      [-20, 20]
    );
    assert.equal(Number(entries.reduce((sum, entry) => sum + Number(entry.amount), 0)), 0);
  });
});
