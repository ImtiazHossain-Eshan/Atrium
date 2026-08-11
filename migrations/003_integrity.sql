-- Second audit pass over the supplied dataset.
--
-- 002 corrected the session-level defects (Sunday and out-of-hours sessions,
-- room and person overlaps, over-capacity, decimal credits). This migration
-- corrects the defects that survived that pass: enrolments stranded on
-- cancelled sessions, an attendance table that was never audited at all, and a
-- schema that still allowed a NULL in almost every column that matters.
--
-- No rows are deleted except in check_in, where the rows are not merely
-- questionable but impossible (attendance recorded outside the session it
-- belongs to). Everything else is corrected in place and left auditable.

-- ---------------------------------------------------------------------------
-- 1. Enrolments stranded on cancelled sessions
-- ---------------------------------------------------------------------------
-- Cancelling a session must release its participants and return what they paid.
-- 002 cancelled five invalid historical sessions but left their enrolments
-- 'active', and the supplied seed already contained the same inconsistency on
-- sessions it had cancelled itself. The result was participants holding paid,
-- active places in sessions that will never run: the rows still appeared in
-- /api/bookings, and cancelling them through the API was impossible because the
-- session was already cancelled.
--
-- This is written as a predicate over the data rather than against a list of
-- ids, so it corrects every occurrence rather than the ones that happened to be
-- noticed. A coach cancellation refunds the participant in full (they did
-- nothing wrong), which is the same rule the application applies.
with stranded as (
  update enrolment e
     set status = 'cancelled',
         credits_refunded = e.credits_charged,
         cancelled_at = coalesce(e.cancelled_at, now())
    from session s
   where s.id = e.session_id
     and s.status = 'cancelled'
     and e.status = 'active'
  returning e.id, e.person_id, e.session_id, e.credits_charged
),
refunded as (
  update person p
     set credits = p.credits + totals.amount
    from (select person_id, sum(credits_charged)::integer as amount from stranded group by person_id) totals
   where p.id = totals.person_id
  returning p.id
)
insert into credit_ledger (person_id, amount, reason, reference_id)
select person_id, credits_charged, 'migration: refund for cancelled session', session_id
  from stranded
 where credits_charged > 0;

-- ---------------------------------------------------------------------------
-- 2. Attendance
-- ---------------------------------------------------------------------------
-- check_in was carried by the starter schema, populated by the seed, and never
-- read by anything. It had no NOT NULL, no uniqueness, and no relationship to
-- the session clock, so nothing stopped the seed generator from recording
-- attendance for sessions that have not happened yet. The great majority of the
-- table is in that state.
--
-- Three impossibilities are removed:
--   a. attendance timestamped outside its own session's interval
--   b. attendance against a cancelled enrolment or a cancelled session
--   c. the same enrolment checked in more than once
--
-- (a) and (c) are time-independent. (b) is too. The remaining rows are those
-- describing sessions that had already run when this migration was applied;
-- a check-in cannot exist for a session that has not started, so any row whose
-- session is still in the future when the correction runs is discarded with the
-- rest.
delete from check_in c
 using enrolment e, session s
 where c.enrolment_id = e.id
   and s.id = e.session_id
   and (
        c.checked_in_at < s.starts_at
     or c.checked_in_at > s.ends_at
     or e.status = 'cancelled'
     or s.status = 'cancelled'
     or s.ends_at > now()
   );

delete from check_in c
 where c.enrolment_id is null
    or c.checked_in_at is null;

-- Keep the earliest check-in per enrolment; a person arrives once.
delete from check_in c
 using check_in keep
 where c.enrolment_id = keep.enrolment_id
   and (keep.checked_in_at, keep.id) < (c.checked_in_at, c.id);

-- ---------------------------------------------------------------------------
-- 3. Session lifecycle
-- ---------------------------------------------------------------------------
-- 'completed' is a valid status the seed uses, but nothing ever moved a session
-- into it, so sessions that had already finished were still advertised as
-- 'scheduled'. The application now runs this transition nightly; this closes
-- the historical backlog.
update session
   set status = 'completed'
 where status = 'scheduled'
   and ends_at < now();

-- ---------------------------------------------------------------------------
-- 4. Column types
-- ---------------------------------------------------------------------------
-- person.created_at was the only naive timestamp left in the schema. A value
-- with no zone is read in whichever zone the reader happens to be in, so the
-- same row meant different instants to the API and to a psql session. The
-- stored values are centre-local wall-clock times, so that is the zone they are
-- anchored to.
alter table person
  alter column created_at type timestamptz
  using created_at at time zone 'America/New_York';

-- ---------------------------------------------------------------------------
-- 5. NOT NULL
-- ---------------------------------------------------------------------------
-- The starter declared almost nothing as required. Every column below is
-- already fully populated; the constraints stop the next writer from
-- reintroducing a gap. A nullable foreign key or status column is how the
-- inconsistencies above became representable in the first place.
alter table person
  alter column email set not null,
  alter column full_name set not null,
  alter column kind set not null,
  alter column credits set not null,
  alter column active set not null,
  alter column created_at set not null;

alter table room
  alter column name set not null,
  alter column capacity set not null;

alter table session
  alter column room_id set not null,
  alter column coach_id set not null,
  alter column discipline set not null,
  alter column session_type set not null,
  alter column status set not null,
  alter column starts_at set not null,
  alter column ends_at set not null,
  alter column room_fee_credits set not null,
  alter column seat_fee_credits set not null,
  alter column created_at set not null;

alter table enrolment
  alter column session_id set not null,
  alter column person_id set not null,
  alter column status set not null,
  alter column credits_charged set not null,
  alter column credits_refunded set not null,
  alter column enrolled_at set not null;

alter table check_in
  alter column enrolment_id set not null,
  alter column checked_in_at set not null;

-- ---------------------------------------------------------------------------
-- 6. Remaining value constraints
-- ---------------------------------------------------------------------------
-- A refund larger than the charge is money created out of nothing.
alter table enrolment
  add constraint enrolment_refund_within_charge
  check (credits_refunded <= credits_charged);

-- A cancelled enrolment has a cancellation time; an active one does not.
alter table enrolment
  add constraint enrolment_cancelled_at_matches_status
  check ((status = 'cancelled') = (cancelled_at is not null));

-- One attendance record per enrolment.
alter table check_in
  add constraint check_in_enrolment_unique unique (enrolment_id);

-- Attendance is meaningless without the enrolment it belongs to.
alter table check_in
  drop constraint check_in_enrolment_id_fkey,
  add constraint check_in_enrolment_id_fkey
    foreign key (enrolment_id) references enrolment(id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 7. Cross-row invariants that a CHECK cannot express
-- ---------------------------------------------------------------------------
-- "A coach may not enrol in their own session" and "attendance belongs inside
-- the session interval" both span two tables, so they are enforced by trigger
-- rather than by CHECK. They are duplicated in application code; the trigger is
-- what makes them true for anything that reaches the database by another route.
create or replace function enrolment_not_own_session() returns trigger as $$
begin
  if exists (select 1 from session s where s.id = new.session_id and s.coach_id = new.person_id) then
    raise exception 'a coach may not enrol in their own session (session %, person %)',
      new.session_id, new.person_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger enrolment_not_own_session_trigger
  before insert or update of session_id, person_id on enrolment
  for each row execute function enrolment_not_own_session();

create or replace function check_in_within_session() returns trigger as $$
declare
  session_row record;
begin
  select s.starts_at, s.ends_at, s.status, e.status as enrolment_status
    into session_row
    from enrolment e join session s on s.id = e.session_id
   where e.id = new.enrolment_id;

  if not found then
    raise exception 'check-in refers to an enrolment that does not exist'
      using errcode = 'foreign_key_violation';
  end if;
  if session_row.enrolment_status <> 'active' or session_row.status = 'cancelled' then
    raise exception 'cannot record attendance against a cancelled booking'
      using errcode = 'check_violation';
  end if;
  if new.checked_in_at < session_row.starts_at or new.checked_in_at > session_row.ends_at then
    raise exception 'attendance must fall inside the session interval'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger check_in_within_session_trigger
  before insert or update on check_in
  for each row execute function check_in_within_session();

-- ---------------------------------------------------------------------------
-- 8. Indexes
-- ---------------------------------------------------------------------------
-- The starter's only index was on (created_at, discipline, status). Nothing
-- queries sessions by creation time: every access path is a time window over
-- starts_at, optionally narrowed by coach or room. It was never used, and it
-- was maintained on every write. 002 added the indexes that match the real
-- access paths; this drops the one that does not.
drop index if exists idx_session_created_discipline_status;

-- The public catalogue and the coach calendar both filter by room over a time
-- window; the exclusion constraint's GiST index serves overlap tests, but the
-- ordered room/time lookup used by the calendar is better served by a btree.
create index if not exists session_room_starts_idx
  on session (room_id, starts_at) where status <> 'cancelled';

-- Attendance is looked up by enrolment; the unique constraint added above
-- already provides that index, so no separate one is created here.
