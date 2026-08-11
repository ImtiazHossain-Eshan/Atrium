'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const timezone = 'America/New_York';

type CalendarEntry = {
  id: number;
  starts_at: string;
  ends_at: string;
  room_name: string;
  visibility: 'busy' | 'details';
  discipline?: string;
  session_type?: string;
  coach_name?: string;
  room_capacity?: number;
  enrolled_count?: number;
  places_remaining?: number;
  relation?: 'teaching' | 'attending';
};

/**
 * The week always starts on the centre's Monday, not the browser's. A user in
 * Dhaka looking at a New York schedule would otherwise see the week boundary
 * fall in the middle of a working day.
 */
function centreParts(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(value);
  const get = (name: string) => parts.find((part) => part.type === name)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday') };
}

const weekdayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function centreWeekStart(value: Date) {
  const { date, weekday } = centreParts(value);
  const offset = Math.max(0, weekdayOrder.indexOf(weekday));
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - offset, 12, 0, 0));
}

function viewDate(value: string | Date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(value));
}

function viewTime(value: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

export default function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => centreWeekStart(new Date()));
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [timezoneLabel, setTimezoneLabel] = useState(timezone);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const weekEnd = useMemo(() => new Date(weekStart.getTime() + 7 * 86400000), [weekStart]);

  useEffect(() => {
    setBusy(true);
    setError('');
    fetch(`${apiBaseUrl}/api/calendar?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`, { credentials: 'include' })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not load the calendar.');
        setEntries(payload.sessions || []);
        setTimezoneLabel(payload.timezone || timezone);
      })
      .catch((err) => setError(err.message || 'Could not load the calendar.'))
      .finally(() => setBusy(false));
  }, [weekStart, weekEnd]);

  const days = useMemo(() => {
    const grouped = new Map<string, CalendarEntry[]>();
    for (const entry of entries) {
      const key = viewDate(entry.starts_at);
      grouped.set(key, [...(grouped.get(key) || []), entry]);
    }
    return Array.from(grouped.entries());
  }, [entries]);

  const busyCount = entries.filter((entry) => entry.visibility === 'busy').length;

  return (
    <main className="dashboard-shell">
      <div className="dashboard-top">
        <div>
          <span className="section-mark">Centre-local calendar</span>
          <h1>Plan the week.</h1>
          <p>Times are shown in {timezoneLabel}. A busy period shows that a room is taken and nothing else — never the discipline, the coach or who is attending.</p>
        </div>
        <Link className="button button-soft" href="/dashboard">Back to dashboard</Link>
      </div>

      <div className="calendar-toolbar">
        <h2>{viewDate(weekStart)} – {viewDate(new Date(weekEnd.getTime() - 86400000))}</h2>
        <div className="dashboard-actions">
          <button className="button button-small button-soft" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * 86400000))}>Previous</button>
          <button className="button button-small button-soft" onClick={() => setWeekStart(centreWeekStart(new Date()))}>This week</button>
          <button className="button button-small button-soft" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * 86400000))}>Next</button>
        </div>
      </div>

      {busy ? (
        <p className="loading">Reading the room board…</p>
      ) : error ? (
        <p className="form-error" role="alert">{error}</p>
      ) : days.length === 0 ? (
        <p className="empty-state">Nothing is scheduled in this week.</p>
      ) : (
        <>
          {busyCount > 0 && (
            <p className="role-note">{busyCount} busy period(s) this week belong to other coaches. You can see the room and the time so you can plan around them.</p>
          )}
          <div className="calendar-list">
            {days.map(([day, dayEntries]) => (
              <section key={day} className="calendar-day">
                <h3 className="calendar-day-heading">{day}</h3>
                {dayEntries.map((entry) => (
                  <article className="calendar-item" id={`session-${entry.id}`} key={entry.id}>
                    <div className="calendar-date">
                      <span className="calendar-time">{viewTime(entry.starts_at)}–{viewTime(entry.ends_at)}</span>
                    </div>
                    <div className="calendar-title">
                      <strong>{entry.visibility === 'busy' ? 'Busy period' : entry.discipline}</strong>
                      <span className="calendar-time">
                        {entry.visibility === 'busy'
                          ? `${entry.room_name} · another coach's session`
                          : `${entry.room_name}${entry.coach_name ? ` · ${entry.coach_name}` : ''}`}
                      </span>
                    </div>
                    <div className="calendar-visibility">
                      {entry.visibility === 'busy'
                        ? 'Details protected'
                        : `${entry.enrolled_count}/${entry.room_capacity} places`}
                    </div>
                    <span className={`session-tag ${entry.visibility}`}>
                      {entry.visibility === 'busy' ? 'room taken' : entry.relation === 'teaching' ? `teaching · ${entry.session_type}` : `attending · ${entry.session_type}`}
                    </span>
                  </article>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
