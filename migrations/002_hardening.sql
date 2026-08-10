-- Production hardening and application state. The starter migration remains
-- unchanged so the original dataset stays auditable.

create extension if not exists btree_gist;

-- Credits are account units, never money-like decimals. Existing historical
-- fractional balances are deliberately rounded down and documented in README.
alter table person
  alter column credits type integer using floor(credits)::integer;
alter table session
  alter column room_fee_credits type integer using round(room_fee_credits)::integer,
  alter column seat_fee_credits type integer using round(seat_fee_credits)::integer;
alter table enrolment
  alter column credits_charged type integer using round(credits_charged)::integer,
  alter column credits_refunded type integer using floor(credits_refunded)::integer;

alter table person
  add constraint person_kind_check check (kind in ('admin', 'coach', 'participant')),
  add constraint person_credits_nonnegative check (credits >= 0);

alter table room
  add constraint room_capacity_positive check (capacity > 0);

alter table session
  add constraint session_type_check check (session_type in ('short', 'standard', 'intensive')),
  add constraint session_status_check check (status in ('scheduled', 'completed', 'cancelled')),
  add constraint session_time_check check (starts_at < ends_at);

alter table enrolment
  add constraint enrolment_status_check check (status in ('active', 'cancelled')),
  add constraint enrolment_credit_check check (credits_charged >= 0 and credits_refunded >= 0);

create unique index person_email_lower_unique on person (lower(email));
create unique index active_enrolment_person_session_unique
  on enrolment (session_id, person_id)
  where status = 'active';

-- Correct known defects in the supplied historical dataset. Invalid legacy
-- sessions are retained as cancelled records; no rows are deleted.
update session set status = 'cancelled' where id in (69, 419, 463, 557, 617);
update session
   set ends_at = starts_at + interval '210 minutes'
 where session_type = 'intensive'
   and ends_at - starts_at = interval '180 minutes';

update enrolment
   set status = 'cancelled', credits_refunded = credits_charged,
       cancelled_at = coalesce(cancelled_at, now())
 where id in (917, 1928);

-- Keep the over-capacity historical booking visible to administrators while
-- returning the excess seat fee to the latest enrolment.
with excess as (
  select e.id
    from enrolment e
    join session s on s.id = e.session_id
    join room r on r.id = s.room_id
   where e.session_id = 83
     and e.status = 'active'
   order by e.enrolled_at desc, e.id desc
   offset 8
)
update enrolment e
   set status = 'cancelled', credits_refunded = credits_charged,
       cancelled_at = coalesce(cancelled_at, now())
 where e.id in (select id from excess);

alter table session
  add constraint active_room_no_overlap
  exclude using gist (
    room_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status <> 'cancelled');

create index session_starts_active_idx on session (starts_at) where status <> 'cancelled';
create index session_coach_starts_idx on session (coach_id, starts_at) where status <> 'cancelled';
create index enrolment_person_status_idx on enrolment (person_id, status, session_id);
create index enrolment_session_status_idx on enrolment (session_id, status);

create table app_session (
  id         bigserial primary key,
  person_id  integer not null references person(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);

create index app_session_person_idx on app_session (person_id);
create index app_session_expiry_idx on app_session (expires_at);

create table password_reset_token (
  id         bigserial primary key,
  person_id  integer not null references person(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create index password_reset_person_idx on password_reset_token (person_id, expires_at);

create table credit_ledger (
  id           bigserial primary key,
  person_id    integer not null references person(id),
  amount       integer not null check (amount <> 0),
  reason       text not null,
  reference_id integer,
  created_at   timestamptz not null default now()
);

create index credit_ledger_person_created_idx on credit_ledger (person_id, created_at desc);
