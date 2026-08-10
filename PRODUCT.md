# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing starter stack preserved: Node, Express, TypeScript, PostgreSQL, Next.js, React, and TypeScript. Database access remains raw `pg` unless a narrowly scoped addition materially improves correctness. Testing, validation, email, scheduling, and model-provider choices are delegated to implementation with local deterministic adapters required for reproducibility.

## Users

- Participants book places in coaching sessions, manage their own bookings, and track their credit balance.
- Coaches book rooms, teach sessions, attend other coaches' sessions, manage their own sessions, and see their own attendee details.
- Administrators manage the centre and can see all operational data.
- Anonymous visitors browse sessions, understand costs and cancellation rules, and may begin a booking through the assistant.

## Product Purpose

Atrium is a coaching-centre booking system for twelve rooms operating Monday to Saturday, 07:00–21:00 in `America/New_York`. It must make room booking, participant enrollment, cancellation, credits, notifications, calendars, and role-aware assistance dependable enough for daily centre operations.

## Positioning

The product's meaningful mechanism is one booking system with one identity and one assistant whose answers and actions are executed as the caller, while room, person, credit, and notification rules remain consistent across the public site, dashboards, API, and model tools.

## Operating Context

Sessions are `SHORT` (45 minutes), `STANDARD` (60 minutes), or `INTENSIVE` (180 minutes of teaching with a 30-minute lunch interval; the room is held for 210 minutes). All time intervals are half-open. Credits are integer account units. The centre is closed on Sundays. Scheduled jobs run at midnight in centre-local time and must remain correct across daylight-saving changes.

## Capabilities and Constraints

- One unified login resolves the signed-in person to participant, coach, or administrator behavior.
- Participants must never receive other participants' data.
- Coaches see their own attendee details and other coaches' busy periods without attendee identities.
- Administrators see everything.
- Participants receive 4000 starting credits; coaches receive 2000.
- Coaches must book rooms at least 48 hours before a session.
- The coach cancellation policy is fixed by the brief: 100% at 96+ hours, 50% at 48–<96 hours, 25% at 24–<48 hours, and 0% under 24 hours.
- Assignment-delegated assumptions: room fees are 30/40/120 credits for short/standard/intensive; seat fees are 15/20/60; participant cancellation uses the same notice tiers unless the implementation evidence shows a safer participant-first policy; fractional refunds round down to protect integer-credit accounting; coach cancellation refunds affected participant bookings at 100%.
- The public page must state all fees, deadlines, refund rules, session types, opening hours, and material consequences before booking.
- The assistant must use permission-filtered tools and never send unauthorized records to a model provider.
- Mobile web must remain usable at 375px with loading, empty, error, success, and permission states.

## Brand Commitments

Product name: Atrium. User-requested visual constraint: a light theme with an off-white paper-like surface. The interface should remain calm, practical, readable, and deliberately finished.

## Evidence on Hand

- Starter repository: `A:\Metaora Project\atrium`.
- Assignment brief: `assignment\ASSIGNMENT.md`.
- Existing schema and seeded historical data: `migrations\001_init.sql`.
- Existing public page, login page, and administrator pages in `web\app`.
- No supplied logo, photography, testimonials, or external brand assets; do not invent factual claims or testimonials.

## Product Principles

1. Enforce rules where the data changes, not only where the screen displays them.
2. Make the next safe action obvious for the current role.
3. Keep money, time, access, and notification behavior explainable.
4. Treat the public page as part of the booking contract.
5. Prefer resilient local behavior and deterministic tests over provider-specific magic.

## Accessibility & Inclusion

Use semantic HTML, keyboard-operable controls, visible focus, accessible names, sufficient contrast, responsive layouts, clear error recovery, and no information conveyed by color alone. The primary responsive acceptance width is 375px.
