import cron from 'node-cron';
import { query } from './db';
import { sendMail } from './notifications';

const timezone = process.env.CENTRE_TIMEZONE || 'America/New_York';
const partsFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const offsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' });

function localDateString(value: Date): string {
  const parts = Object.fromEntries(partsFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function offsetMilliseconds(value: Date): number {
  const name = offsetFormatter.formatToParts(value).find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return (match[1] === '-' ? -1 : 1) * minutes * 60 * 1000;
}

function localMidnight(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const naive = new Date(Date.UTC(year, month - 1, day));
  let guess = new Date(naive.getTime() - offsetMilliseconds(naive));
  guess = new Date(naive.getTime() - offsetMilliseconds(guess));
  return guess;
}

export function localDayWindow(date = new Date()): { date: string; from: Date; to: Date } {
  const day = localDateString(date);
  const from = localMidnight(day);
  const next = new Date(from.getTime() + 36 * 60 * 60 * 1000);
  const to = localMidnight(localDateString(next));
  return { date: day, from, to };
}

export async function sendDailyDigests(now = new Date()): Promise<void> {
  const window = localDayWindow(now);
  const coaches = await query<{ id: number; email: string; full_name: string }>("select id, email, full_name from person where kind = 'coach' and active = true");
  for (const coach of coaches) {
    const sessions = await query<any>(
      `select s.discipline, s.starts_at, s.ends_at, r.name as room_name,
              count(e.id) filter (where e.status = 'active')::int as attendees
         from session s join room r on r.id = s.room_id left join enrolment e on e.session_id = s.id
        where s.coach_id = $1 and s.status <> 'cancelled' and s.starts_at >= $2 and s.starts_at < $3
        group by s.id, r.id order by s.starts_at`,
      [coach.id, window.from, window.to]
    );
    if (!sessions.length) continue;
    await sendMail({
      to: coach.email,
      subject: `Atrium bookings for ${window.date}`,
      text: sessions.map((s) => `${s.discipline}: ${new Date(s.starts_at).toLocaleTimeString()} in ${s.room_name} (${s.attendees} attendees)`).join('\n')
    });
  }

  const adminRows = await query<{ email: string }>("select email from person where kind = 'admin' and active = true");
  const digest = await query<any>(
    `select s.discipline, s.starts_at, p.full_name as coach_name,
            count(e.id) filter (where e.status = 'active')::int as attendees
       from session s join person p on p.id = s.coach_id left join enrolment e on e.session_id = s.id
      where s.status <> 'cancelled' and s.starts_at >= $1 and s.starts_at < $2
      group by s.id, p.id order by s.starts_at`,
    [window.from, window.to]
  );
  for (const admin of adminRows) {
    await sendMail({
      to: admin.email,
      subject: `Atrium daily digest for ${window.date}`,
      text: digest.length ? digest.map((s) => `${s.discipline}: ${s.coach_name}: ${s.attendees} attendees`).join('\n') : 'No bookings today.'
    });
  }
}

export function startScheduler(): void {
  if (process.env.SCHEDULER_ENABLED !== 'true') return;
  cron.schedule('0 0 * * *', () => void sendDailyDigests().catch(console.error), { timezone });
  console.log(`scheduler enabled at midnight in ${timezone}`);
}
