import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  centreDateTime,
  centreDayWindow,
  centreInstant,
  centreMidnight,
  isOpenWindow,
  overlaps,
  validateSessionWindow
} from '../src/domain';

const hours = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 3_600_000;

test('a centre-local day is 24 hours on an ordinary date', () => {
  const window = centreDayWindow(new Date('2026-09-15T12:00:00Z'));
  assert.equal(window.date, '2026-09-15');
  assert.equal(hours(window.from, window.to), 24);
});

test('the day daylight saving ends is 25 hours long, not 24', () => {
  // 1 November 2026: clocks go back at 02:00 local, so the local day has an
  // extra hour. A window built by adding 24 hours to local midnight would stop
  // an hour early and under-report the digest.
  const window = centreDayWindow(new Date('2026-11-01T12:00:00Z'));
  assert.equal(window.date, '2026-11-01');
  assert.equal(hours(window.from, window.to), 25);
});

test('the day daylight saving begins is 23 hours long, not 24', () => {
  // 8 March 2026: clocks go forward at 02:00 local. Adding 24 hours would run
  // an hour into the following day and double-count its first session.
  const window = centreDayWindow(new Date('2026-03-08T12:00:00Z'));
  assert.equal(window.date, '2026-03-08');
  assert.equal(hours(window.from, window.to), 23);
});

test('local midnight is a real instant on both sides of a transition', () => {
  // Eastern time is UTC-4 before the change and UTC-5 after it.
  assert.equal(centreMidnight('2026-10-31').toISOString(), '2026-10-31T04:00:00.000Z');
  assert.equal(centreMidnight('2026-11-02').toISOString(), '2026-11-02T05:00:00.000Z');
});

test('a wall-clock time resolves to the right instant either side of a transition', () => {
  assert.equal(centreInstant('2026-10-30', '14:00'), '2026-10-30T18:00:00.000Z');
  assert.equal(centreInstant('2026-11-03', '14:00'), '2026-11-03T19:00:00.000Z');
});

test('the centre day window covers every instant of the transition day exactly once', () => {
  const window = centreDayWindow(new Date('2026-11-01T12:00:00Z'));
  // The repeated 01:30 local hour occurs twice; both instants belong to the day.
  const firstOnePast = new Date('2026-11-01T05:30:00Z');
  const secondOnePast = new Date('2026-11-01T06:30:00Z');
  for (const instant of [firstOnePast, secondOnePast]) {
    assert.ok(instant >= window.from && instant < window.to, `${instant.toISOString()} should fall inside the local day`);
  }
  const nextDay = centreDayWindow(new Date('2026-11-02T12:00:00Z'));
  assert.equal(window.to.getTime(), nextDay.from.getTime(), 'consecutive day windows must meet exactly, with no gap or overlap');
});

test('times are rendered in centre time regardless of the server zone', () => {
  // 18:00 UTC on 15 July is 14:00 in New York.
  assert.match(centreDateTime('2026-07-15T18:00:00Z'), /14:00/);
});

test('the centre is closed on Sundays', () => {
  const sundayStart = new Date(centreInstant('2026-08-16', '10:00'));
  const sundayEnd = new Date(sundayStart.getTime() + 60 * 60000);
  assert.equal(isOpenWindow(sundayStart, sundayEnd), false);
});

test('a session must fit entirely inside opening hours', () => {
  const early = new Date(centreInstant('2026-08-17', '06:30'));
  assert.equal(isOpenWindow(early, new Date(early.getTime() + 60 * 60000)), false);

  const lateStart = new Date(centreInstant('2026-08-17', '20:30'));
  assert.equal(isOpenWindow(lateStart, new Date(lateStart.getTime() + 60 * 60000)), false, 'ending at 21:30 is outside opening hours');

  const lastSlot = new Date(centreInstant('2026-08-17', '20:00'));
  assert.equal(isOpenWindow(lastSlot, new Date(lastSlot.getTime() + 60 * 60000)), true, 'ending exactly at 21:00 is allowed');

  const firstSlot = new Date(centreInstant('2026-08-17', '07:00'));
  assert.equal(isOpenWindow(firstSlot, new Date(firstSlot.getTime() + 60 * 60000)), true, 'starting exactly at 07:00 is allowed');
});

test('each session type must hold the room for its own duration', () => {
  const start = centreInstant('2026-08-17', '09:00');
  const plus = (minutes: number) => new Date(new Date(start).getTime() + minutes * 60000).toISOString();

  assert.equal(validateSessionWindow('short', start, plus(45)), null);
  assert.equal(validateSessionWindow('standard', start, plus(60)), null);
  // An intensive teaches for 180 minutes but holds the room for 210 because of
  // the 30-minute interval in the middle.
  assert.equal(validateSessionWindow('intensive', start, plus(210)), null);
  assert.notEqual(validateSessionWindow('intensive', start, plus(180)), null);
  assert.notEqual(validateSessionWindow('standard', start, plus(45)), null);
  assert.notEqual(validateSessionWindow('epic', start, plus(60)), null);
});

test('an intensive that would run past closing is rejected', () => {
  // 18:00 + 210 minutes is 21:30.
  const start = centreInstant('2026-08-17', '18:00');
  const end = new Date(new Date(start).getTime() + 210 * 60000).toISOString();
  assert.notEqual(validateSessionWindow('intensive', start, end), null);
});

test('intervals are half-open: touching sessions do not conflict', () => {
  const nine = new Date('2026-08-17T13:00:00Z');
  const ten = new Date('2026-08-17T14:00:00Z');
  const eleven = new Date('2026-08-17T15:00:00Z');

  assert.equal(overlaps(nine, ten, ten, eleven), false, 'one ending as the other starts is not an overlap');
  assert.equal(overlaps(nine, eleven, ten, eleven), true);
  assert.equal(overlaps(ten, eleven, nine, eleven), true);
});
