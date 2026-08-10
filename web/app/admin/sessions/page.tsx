'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const timezone = 'America/New_York';
const durations: Record<string, number> = { short: 45, standard: 60, intensive: 210 };
type User = { id: number; full_name: string; kind: 'admin' | 'coach' | 'participant' };
type Session = { id: number; coach_id: number; discipline: string; session_type: string; starts_at: string; ends_at: string; room_name: string; room_capacity: number; coach_name: string; enrolled_count: number };

function weekStart(value: Date) { const date = new Date(value); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date; }
function zoneOffset(date: Date) { const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(date).find((item) => item.type === 'timeZoneName')?.value || 'GMT'; const match = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/); if (!match) return 0; return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] || 0)) * 60000; }
function centreIso(date: string, time: string) { const [year, month, day] = date.split('-').map(Number); const [hour, minute] = time.split(':').map(Number); const naive = new Date(Date.UTC(year, month - 1, day, hour, minute)); return new Date(naive.getTime() - zoneOffset(naive)).toISOString(); }
function display(value: string) { return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
function localPart(value: string, type: 'date' | 'time') { const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)); const get = (name: string) => parts.find((part) => part.type === name)?.value || ''; return type === 'date' ? `${get('year')}-${get('month')}-${get('day')}` : `${get('hour')}:${get('minute')}`; }

export default function SessionManagement() {
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [week, setWeek] = useState(() => weekStart(new Date()));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [coaches, setCoaches] = useState<any[]>([]);
  const [form, setForm] = useState({ date: '', start: '09:00', type: 'standard', discipline: 'fitness', room_id: '', coach_id: '' });
  const [move, setMove] = useState<{ id: number; date: string; start: string; type: string } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const end = useMemo(() => new Date(week.getTime() + 7 * 86400000), [week]);

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/me`, { credentials: 'include' }).then(async (response) => {
      if (!response.ok) { window.location.href = '/login'; return; }
      setUser(await response.json());
      setAuthChecked(true);
    }).catch(() => { setError('The session desk could not identify you.'); setAuthChecked(true); });
  }, []);

  useEffect(() => {
    if (!user || user.kind === 'participant') return;
    const currentUser = user;
    async function load() {
      try {
        const [sessionResponse, roomResponse, coachResponse] = await Promise.all([
          fetch(`${apiBaseUrl}/api/sessions?from=${week.toISOString()}&to=${end.toISOString()}`, { credentials: 'include' }),
          fetch(`${apiBaseUrl}/api/rooms`, { credentials: 'include' }),
          currentUser.kind === 'admin' ? fetch(`${apiBaseUrl}/api/people?kind=coach`, { credentials: 'include' }) : Promise.resolve(null)
        ]);
        if (sessionResponse.status === 401 || sessionResponse.status === 403) { window.location.href = '/dashboard'; return; }
        if (!sessionResponse.ok || !roomResponse.ok) throw new Error('Could not load the management board.');
        const sessionData = await sessionResponse.json();
        setSessions(currentUser.kind === 'coach' ? sessionData.filter((session: Session) => session.coach_id === currentUser.id) : sessionData);
        setRooms(await roomResponse.json());
        setCoaches(coachResponse && coachResponse.ok ? await coachResponse.json() : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the management board.');
      }
    }
    void load();
  }, [end, user, week]);

  const endTime = useMemo(() => { if (!form.start) return ''; const [hour, minute] = form.start.split(':').map(Number); const total = hour * 60 + minute + durations[form.type]; return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; }, [form.start, form.type]);
  const moveEndTime = useMemo(() => { if (!move?.start) return ''; const [hour, minute] = move.start.split(':').map(Number); const total = hour * 60 + minute + durations[move.type]; return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; }, [move]);

  async function create(event: FormEvent) {
    event.preventDefault(); setError(''); setMessage('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ room_id: Number(form.room_id), coach_id: form.coach_id ? Number(form.coach_id) : undefined, discipline: form.discipline, session_type: form.type, starts_at: centreIso(form.date, form.start), ends_at: centreIso(form.date, endTime) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setMessage('Session created and the room fee was charged.');
      setWeek(weekStart(new Date(payload.starts_at)));
      setForm({ ...form, date: '', room_id: '', coach_id: '' });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create the session.'); }
  }

  async function cancel(id: number) {
    if (!window.confirm('Cancel this session and refund affected participants?')) return;
    const response = await fetch(`${apiBaseUrl}/api/sessions/${id}/cancel`, { method: 'POST', credentials: 'include' });
    const payload = await response.json();
    if (!response.ok) setError(payload.error || 'Could not cancel the session.'); else { setMessage('Session cancelled and refunds applied.'); setSessions((current) => current.filter((session) => session.id !== id)); }
  }

  async function reschedule(event: FormEvent) {
    event.preventDefault(); if (!move) return;
    setError(''); setMessage('');
    const response = await fetch(`${apiBaseUrl}/api/sessions/${move.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ starts_at: centreIso(move.date, move.start), ends_at: centreIso(move.date, moveEndTime) }) });
    const payload = await response.json();
    if (!response.ok) setError(payload.error || 'Could not move the session.'); else { setMessage('Session moved and enrolled attendees were notified.'); setMove(null); setSessions((current) => current.map((session) => session.id === payload.id ? payload : session)); }
  }

  if (!authChecked) return <main className="dashboard-shell"><p className="loading">Opening the session desk…</p></main>;
  if (!user || user.kind === 'participant') return <main className="dashboard-shell"><p className="form-error" role="alert">Only coaches and administrators can manage rooms.</p></main>;

  return <main className="dashboard-shell">
    <div className="dashboard-top"><div><span className="section-mark">{user.kind === 'admin' ? 'Administrator tools' : 'Coach tools'}</span><h1>{user.kind === 'admin' ? 'Manage the board.' : 'Shape your sessions.'}</h1><p>{user.kind === 'admin' ? 'Schedule rooms, protect conflicts, and keep the public calendar honest.' : 'Book a room, move your own session, and keep attendees informed.'}</p></div><Link className="button button-soft" href="/dashboard">Back to dashboard</Link></div>
    {message && <p className="role-note" role="status">{message}</p>}{error && <p className="form-error" role="alert">{error}</p>}
    <section className="panel"><div className="panel-heading"><h2>{user.kind === 'admin' ? 'All sessions' : 'Your sessions'} · week of {display(week.toISOString())}</h2><div className="dashboard-actions"><button className="button button-small button-soft" onClick={() => setWeek(new Date(week.getTime() - 7 * 86400000))}>Previous</button><button className="button button-small button-soft" onClick={() => setWeek(new Date(week.getTime() + 7 * 86400000))}>Next</button></div></div><div className="calendar-list">{sessions.length ? sessions.map((session) => <article className="calendar-item" key={session.id}><div className="calendar-date">{display(session.starts_at)}<span className="calendar-time">{session.room_name}</span></div><div className="calendar-title"><strong>{session.discipline}</strong><span className="calendar-time">{session.coach_name} · {session.enrolled_count}/{session.room_capacity} places</span></div><span className="session-tag">{session.session_type}</span><div className="calendar-actions"><button className="link-button" onClick={() => setMove({ id: session.id, date: localPart(session.starts_at, 'date'), start: localPart(session.starts_at, 'time'), type: session.session_type })}>Move</button><button className="link-button" onClick={() => cancel(session.id)}>Cancel</button></div>{move?.id === session.id && <form className="calendar-inline-form" onSubmit={reschedule}><label className="field">New date<input type="date" required value={move.date} onChange={(event) => setMove({ ...move, date: event.target.value })} /></label><label className="field">New start<input type="time" required value={move.start} onChange={(event) => setMove({ ...move, start: event.target.value })} /></label><span className="agenda-sub">Ends {moveEndTime} New York time.</span><button className="button button-small button-cobalt">Save move</button></form>}</article>) : <p className="empty-state">No active sessions in this week.</p>}</div></section>
    <section className="section" style={{ paddingBottom: 0 }}><div className="panel"><div className="panel-heading"><h2>Book a room</h2></div><form className="form-stack" onSubmit={create} style={{ maxWidth: 720, paddingTop: 20 }}><div className="policy-copy"><label className="field">Date in New York<input type="date" required value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label><label className="field">Starts in New York<input type="time" required value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} /></label></div><div className="policy-copy"><label className="field">Discipline<input required value={form.discipline} onChange={(event) => setForm({ ...form, discipline: event.target.value })} /></label><label className="field">Type<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="short">Short · 45 minutes</option><option value="standard">Standard · 60 minutes</option><option value="intensive">Intensive · 210-minute room hold</option></select></label></div><div className="policy-copy"><label className="field">Room<select required value={form.room_id} onChange={(event) => setForm({ ...form, room_id: event.target.value })}><option value="">Choose a room</option>{rooms.map((room) => <option value={room.id} key={room.id}>{room.name} · {room.capacity} places</option>)}</select></label>{user.kind === 'admin' ? <label className="field">Coach<select required value={form.coach_id} onChange={(event) => setForm({ ...form, coach_id: event.target.value })}><option value="">Choose a coach</option>{coaches.map((coach) => <option value={coach.id} key={coach.id}>{coach.full_name}</option>)}</select></label> : <p className="role-note">This room booking is assigned to you. Coaches must book at least 48 hours ahead.</p>}</div><p className="agenda-sub">Ends at {endTime} New York time. Intensive sessions include the lunch interval.</p><button className="button button-cobalt" style={{ width: 'max-content' }}>Create session</button></form></div></section>
  </main>;
}
