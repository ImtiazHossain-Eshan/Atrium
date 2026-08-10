import nodemailer from 'nodemailer';
import { query } from './db';

type Mail = { to: string; subject: string; text: string };

function transport() {
  if ((process.env.MAIL_TRANSPORT || 'console') === 'smtp') {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: Number(process.env.SMTP_PORT || 1025),
      secure: false,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined
    });
  }
  return nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
}

export async function sendMail(mail: Mail): Promise<void> {
  try {
    const info = await transport().sendMail({ from: process.env.MAIL_FROM || 'no-reply@atrium.local', ...mail });
    if ((process.env.MAIL_TRANSPORT || 'console') !== 'smtp') {
      console.log(`[mail stub] ${mail.to} | ${mail.subject}\n${mail.text}`);
    }
  } catch (err) {
    console.error('[mail]', err);
  }
}

export async function sendPasswordSetup(email: string, token: string): Promise<void> {
  const base = process.env.WEB_BASE_URL || 'http://localhost:3000';
  await sendMail({
    to: email,
    subject: 'Set your Atrium password',
    text: `Set your Atrium password within 30 minutes: ${base}/reset-password?token=${token}`
  });
}

export async function notifyBooking(sessionId: number, personId: number): Promise<void> {
  const rows = await query<any>(
    `select s.discipline, s.starts_at, p.email as coach_email, p.full_name as coach_name,
            b.full_name as attendee_name
       from session s join person p on p.id = s.coach_id join person b on b.id = $2 where s.id = $1`,
    [sessionId, personId]
  );
  if (!rows[0]) return;
  await sendMail({ to: rows[0].coach_email, subject: `New booking for ${rows[0].discipline}`, text: `${rows[0].attendee_name} booked your session starting ${new Date(rows[0].starts_at).toLocaleString()}.` });
}

export async function notifySessionCancelled(sessionId: number): Promise<void> {
  const rows = await query<any>(
    `select s.discipline, s.starts_at, p.email as recipient_email, p.full_name as recipient_name
       from session s join enrolment e on e.session_id = s.id join person p on p.id = e.person_id
      where s.id = $1 and e.status = 'cancelled' and e.cancelled_at >= now() - interval '1 minute'`,
    [sessionId]
  );
  for (const row of rows) {
    await sendMail({ to: row.recipient_email, subject: `Session cancelled: ${row.discipline}`, text: `Your Atrium session on ${new Date(row.starts_at).toLocaleString()} was cancelled by the coach. Your place fee was fully refunded.` });
  }
}

export async function notifyAdmins(subject: string, text: string): Promise<void> {
  const admins = await query<{ email: string }>("select email from person where kind = 'admin' and active = true");
  for (const admin of admins) await sendMail({ to: admin.email, subject, text });
}

export async function notifyBookingCancelled(sessionId: number, personId: number): Promise<void> {
  const rows = await query<any>(
    `select s.discipline, s.starts_at, coach.email as coach_email, coach.full_name as coach_name,
            attendee.full_name as attendee_name
       from session s join person coach on coach.id = s.coach_id join person attendee on attendee.id = $2
      where s.id = $1`,
    [sessionId, personId]
  );
  if (!rows[0]) return;
  await sendMail({ to: rows[0].coach_email, subject: `Booking changed for ${rows[0].discipline}`, text: `${rows[0].attendee_name} cancelled their place in your session on ${new Date(rows[0].starts_at).toLocaleString()}.` });
}

export async function notifySessionChanged(sessionId: number): Promise<void> {
  const rows = await query<any>(
    `select distinct p.email, s.discipline, s.starts_at
       from session s join enrolment e on e.session_id = s.id and e.status = 'active'
       join person p on p.id = e.person_id where s.id = $1`,
    [sessionId]
  );
  for (const row of rows) await sendMail({ to: row.email, subject: `Session updated: ${row.discipline}`, text: `Your Atrium session on ${new Date(row.starts_at).toLocaleString()} has changed. Please review your calendar.` });
}
