'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const timezone = 'America/New_York';
function monday(value: Date) { const date = new Date(value); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date; }
function viewDate(value: string) { return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(value)); }
function viewTime(value: string) { return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }

export default function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => monday(new Date()));
  const [sessions, setSessions] = useState<any[]>([]);
  const [timezoneLabel, setTimezoneLabel] = useState(timezone);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const weekEnd = useMemo(() => new Date(weekStart.getTime() + 7 * 86400000), [weekStart]);

  useEffect(() => { setBusy(true); setError(''); fetch(`${apiBaseUrl}/api/calendar?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`, { credentials: 'include' }).then(async (response) => { if (response.status === 401) { window.location.href = '/login'; return; } const payload = await response.json(); if (!response.ok) throw new Error(payload.error); setSessions(payload.sessions || []); setTimezoneLabel(payload.timezone || timezone); }).catch((err) => setError(err.message || 'Could not load the calendar.')).finally(() => setBusy(false)); }, [weekStart, weekEnd]);

  return <main className="dashboard-shell"><div className="dashboard-top"><div><span className="section-mark">Centre-local calendar</span><h1>Plan the week.</h1><p>Times are shown in {timezoneLabel}. A busy period never reveals someone else’s attendees.</p></div><Link className="button button-soft" href="/dashboard">Back to dashboard</Link></div><div className="calendar-toolbar"><h2>{viewDate(weekStart.toISOString())} – {viewDate(new Date(weekEnd.getTime() - 1).toISOString())}</h2><div className="dashboard-actions"><button className="button button-small button-soft" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * 86400000))}>Previous</button><button className="button button-small button-soft" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * 86400000))}>Next</button></div></div>{busy ? <p className="loading">Reading the room board…</p> : error ? <p className="form-error" role="alert">{error}</p> : <div className="calendar-list">{sessions.length ? sessions.map((session) => <article className="calendar-item" id={`session-${session.id}`} key={session.id}><div className="calendar-date">{viewDate(session.starts_at)}<span className="calendar-time">{viewTime(session.starts_at)}–{viewTime(session.ends_at)}</span></div><div className="calendar-title"><strong>{session.visibility === 'busy' ? 'Busy period' : session.discipline}</strong><span className="calendar-time">{session.visibility === 'busy' ? 'Another coach’s session' : `${session.room_name} · ${session.coach_name}`}</span></div><div className="calendar-visibility">{session.visibility === 'details' ? `${session.enrolled_count}/${session.room_capacity} places` : 'Details protected'}</div><span className={`session-tag ${session.visibility}`}>{session.session_type}</span></article>) : <p className="empty-state">Nothing is scheduled in this week yet.</p>}</div>}</main>;
}
