'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const timezone = 'America/New_York';

type Session = {
  id: number;
  coach_id: number;
  discipline: string;
  session_type: string;
  starts_at: string;
  ends_at: string;
  room_name: string;
  seat_fee_credits: number;
  places_remaining: number;
  own_booking?: string | null;
};

type User = { id: number; kind: 'admin' | 'coach' | 'participant' };

function format(value: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options }).format(new Date(value));
}

function dayKey(value: string) {
  return format(value, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function dayLabel(value: string) {
  return format(value, { weekday: 'long', month: 'long', day: 'numeric' });
}

function timeRange(session: Session) {
  return `${format(session.starts_at, { hour: 'numeric', minute: '2-digit' })} - ${format(session.ends_at, { hour: 'numeric', minute: '2-digit' })}`;
}

export default function SessionBoardFoldable({ initialSessions }: { initialSessions: Session[] }) {
  const [sessions, setSessions] = useState(initialSessions);
  const [user, setUser] = useState<User | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [visibleDayCount, setVisibleDayCount] = useState(2);
  const [openDayKeys, setOpenDayKeys] = useState<Set<string>>(() => {
    const firstSession = initialSessions[0];
    return firstSession ? new Set([dayKey(firstSession.starts_at)]) : new Set();
  });

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/me`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then(async (nextUser) => {
        setUser(nextUser);
        if (!nextUser) return;
        const from = new Date();
        const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
        const response = await fetch(`${apiBaseUrl}/api/sessions?from=${from.toISOString()}&to=${to.toISOString()}`, { credentials: 'include' });
        if (response.ok) setSessions(await response.json());
      })
      .catch(() => setUser(null));
  }, []);

  async function book(sessionId: number) {
    if (!user) { window.location.href = '/login'; return; }
    if (user.kind === 'admin') { window.location.href = '/dashboard'; return; }
    setBusyId(sessionId);
    setMessage('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/bookings/${sessionId}/book`, { method: 'POST', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'That session could not be booked.');
      setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, own_booking: 'active', places_remaining: Math.max(0, session.places_remaining - 1) } : session));
      setMessage(`Session ${sessionId} is now in your dashboard.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That session could not be booked.');
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(sessionId: number) {
    if (!window.confirm('Cancel this booking and apply the published refund policy?')) return;
    setBusyId(sessionId);
    setMessage('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/bookings/${sessionId}/cancel`, { method: 'POST', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'That booking could not be cancelled.');
      setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, own_booking: 'cancelled', places_remaining: session.places_remaining + 1 } : session));
      setMessage(`Booking cancelled. ${payload.refund} credits were returned under the notice policy.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That booking could not be cancelled.');
    } finally {
      setBusyId(null);
    }
  }

  function action(session: Session) {
    if (!user) return <Link className="button button-small button-plum" href="/login">Sign in to book</Link>;
    if (user.kind === 'admin') return <Link className="button button-small button-soft" href="/dashboard">Open desk</Link>;
    if (user.kind === 'coach' && session.coach_id === user.id) return <span className="session-action-note">Your session</span>;
    if (session.own_booking === 'active') return <button className="button button-small button-soft" disabled={busyId === session.id} onClick={() => cancel(session.id)}>{busyId === session.id ? 'Updating...' : 'Cancel booking'}</button>;
    return <button className="button button-small button-lime" disabled={busyId === session.id || session.places_remaining < 1} onClick={() => book(session.id)}>{busyId === session.id ? 'Booking...' : session.places_remaining < 1 ? 'Full' : 'Book a place'}</button>;
  }

  function toggleDay(key: string) {
    setOpenDayKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const groups = useMemo(() => {
    const grouped = new Map<string, Session[]>();
    for (const session of sessions) {
      grouped.set(dayKey(session.starts_at), [...(grouped.get(dayKey(session.starts_at)) || []), session]);
    }
    return Array.from(grouped.entries());
  }, [sessions]);

  return <>
    <div className="session-list">
      {groups.length ? groups.slice(0, visibleDayCount).map(([key, daySessions]) => <details className="session-day-group" key={key} open={openDayKeys.has(key)}>
        <summary className="session-day-heading" onClick={(event) => { event.preventDefault(); toggleDay(key); }}>
          <span className="session-day-title"><span className="session-day-kicker">On the board</span><span>{dayLabel(daySessions[0].starts_at)}</span></span>
          <span className="session-day-meta"><span className="session-day-count">{daySessions.length} {daySessions.length === 1 ? 'session' : 'sessions'}</span><span className="session-day-toggle" aria-hidden="true" /></span>
        </summary>
        <div className="session-day-list">{daySessions.map((session) => <article className={`session-row session-type-${session.session_type}`} key={session.id}>
          <div className="session-time-block"><strong>{timeRange(session)}</strong><span>New York time</span></div>
          <div className="session-main"><span className="session-tag">#{session.id} - {session.session_type}</span><div className="session-name">{session.discipline}</div><span className="session-room">{session.room_name}</span></div>
          <div className="session-places"><strong>{session.places_remaining}</strong><span>places left</span><em>{session.seat_fee_credits} credits</em></div>
          <div className="session-action">{action(session)}</div>
        </article>)}</div>
      </details>) : <p className="empty-state">There are no sessions in the next fourteen days. Check back soon or ask the assistant.</p>}
    </div>
    {groups.length > 0 && <div className="session-board-tools">
      <span className="session-board-progress">Showing {Math.min(visibleDayCount, groups.length)} of {groups.length} days</span>
      <div className="session-board-actions">
        {openDayKeys.size > 0 && <button className="button button-small button-soft" type="button" onClick={() => setOpenDayKeys(new Set())}>Fold all</button>}
        {visibleDayCount < groups.length && <button className="button button-small button-lime session-load-more" type="button" onClick={() => setVisibleDayCount((count) => Math.min(count + 3, groups.length))}>Load {Math.min(3, groups.length - visibleDayCount)} more days</button>}
      </div>
    </div>}
    {message && <p className="session-feedback" role="status">{message}</p>}
  </>;
}
