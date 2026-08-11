import nodemailer from 'nodemailer';
import { query } from './db';
import { centreDateTime } from './domain';

type Mail = { to: string; subject: string; text: string };

let cachedTransport: nodemailer.Transporter | null = null;

function transport(): nodemailer.Transporter {
  if (cachedTransport) return cachedTransport;
  if ((process.env.MAIL_TRANSPORT || 'console') === 'smtp') {
    cachedTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: Number(process.env.SMTP_PORT || 1025),
      secure: false,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined
    });
  } else {
    cachedTransport = nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
  }
  return cachedTransport;
}

/**
 * Mail never fails a booking. A cancellation that refunded correctly but could
 * not reach the SMTP server is still a successful cancellation, so delivery
 * problems are logged rather than thrown.
 *
 * When SMTP is configured but unreachable the failure is logged loudly, because
 * the alternative, silence, looks exactly like a system with no email at all.
 */
export async function sendMail(mail: Mail): Promise<void> {
  const mode = process.env.MAIL_TRANSPORT || 'console';
  try {
    await transport().sendMail({ from: process.env.MAIL_FROM || 'no-reply@atrium.local', ...mail });
    if (mode !== 'smtp') {
      console.log(`\n[mail] to: ${mail.to}\n[mail] subject: ${mail.subject}\n${mail.text}\n`);
    }
  } catch (err) {
    console.error(
      `[mail] could not deliver "${mail.subject}" to ${mail.to} over ${mode}. ` +
        `Is the SMTP server running? Set MAIL_TRANSPORT=console to print mail to this log instead.`,
      err
    );
  }
}

export async function sendPasswordSetup(email: string, token: string): Promise<void> {
  const base = process.env.WEB_BASE_URL || 'http://localhost:3000';
  await sendMail({
    to: email,
    subject: 'Set your Atrium password',
    text: `Set your Atrium password within 30 minutes:\n${base}/reset-password?token=${token}`
  });
}

/** A new booking on a coach's session notifies that coach. */
export async function notifyBooking(sessionId: number, personId: number): Promise<void> {
  const rows = await query<any>(
    `select s.discipline, s.starts_at, r.name as room_name,
            coach.email as coach_email, attendee.full_name as attendee_name
       from session s
       join person coach on coach.id = s.coach_id
       join room r on r.id = s.room_id
       join person attendee on attendee.id = $2
      where s.id = $1`,
    [sessionId, personId]
  );
  const row = rows[0];
  if (!row) return;
  await sendMail({
    to: row.coach_email,
    subject: `New booking for ${row.discipline}`,
    text: `${row.attendee_name} booked a place in your ${row.discipline} session on ${centreDateTime(row.starts_at)} in ${row.room_name}.`
  });
}

/** A participant changing or cancelling their place notifies that session's coach. */
export async function notifyBookingCancelled(sessionId: number, personId: number): Promise<void> {
  const rows = await query<any>(
    `select s.discipline, s.starts_at, r.name as room_name,
            coach.email as coach_email, attendee.full_name as attendee_name,
            count(e.id) filter (where e.status = 'active')::int as remaining
       from session s
       join person coach on coach.id = s.coach_id
       join room r on r.id = s.room_id
       join person attendee on attendee.id = $2
       left join enrolment e on e.session_id = s.id
      where s.id = $1
      group by s.id, r.id, coach.id, attendee.id`,
    [sessionId, personId]
  );
  const row = rows[0];
  if (!row) return;
  await sendMail({
    to: row.coach_email,
    subject: `Booking cancelled for ${row.discipline}`,
    text:
      `${row.attendee_name} cancelled their place in your ${row.discipline} session on ` +
      `${centreDateTime(row.starts_at)} in ${row.room_name}. ${row.remaining} place(s) are now taken.`
  });
}

/**
 * A cancelled session notifies everyone who held a place: participants and any
 * coach who was attending it.
 *
 * The affected people are passed in by the caller rather than inferred from a
 * timestamp window. The previous version looked for enrolments cancelled in the
 * last minute, which silently missed anyone when the transaction ran long and
 * picked up unrelated rows when it did not.
 */
export async function notifySessionCancelled(sessionId: number, personIds: number[]): Promise<void> {
  if (!personIds.length) return;
  const rows = await query<any>(
    `select p.email, p.full_name, s.discipline, s.starts_at, r.name as room_name,
            e.credits_refunded
       from session s
       join room r on r.id = s.room_id
       join enrolment e on e.session_id = s.id
       join person p on p.id = e.person_id
      where s.id = $1 and p.id = any($2::int[])`,
    [sessionId, personIds]
  );
  for (const row of rows) {
    await sendMail({
      to: row.email,
      subject: `Cancelled: ${row.discipline} on ${centreDateTime(row.starts_at)}`,
      text:
        `Your ${row.discipline} session on ${centreDateTime(row.starts_at)} in ${row.room_name} was cancelled by the coach.\n` +
        `${row.credits_refunded} credits have been returned to your account in full. The notice tiers do not apply when a coach cancels.`
    });
  }
}

/** A moved session notifies everyone attending it, coaches included. */
export async function notifySessionChanged(sessionId: number): Promise<void> {
  const rows = await query<any>(
    `select distinct p.email, s.discipline, s.starts_at, s.ends_at, r.name as room_name
       from session s
       join room r on r.id = s.room_id
       join enrolment e on e.session_id = s.id and e.status = 'active'
       join person p on p.id = e.person_id
      where s.id = $1`,
    [sessionId]
  );
  for (const row of rows) {
    await sendMail({
      to: row.email,
      subject: `Rescheduled: ${row.discipline}`,
      text:
        `Your ${row.discipline} session has moved. It now runs on ${centreDateTime(row.starts_at)} in ${row.room_name}.\n` +
        `Your place has moved with it and no credits have changed hands.`
    });
  }
}

export async function notifyAdmins(subject: string, text: string): Promise<void> {
  const admins = await query<{ email: string }>("select email from person where kind = 'admin' and active = true");
  for (const admin of admins) await sendMail({ to: admin.email, subject, text });
}
