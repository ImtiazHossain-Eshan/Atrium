'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

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

function dateFormat(value: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options }).format(new Date(value));
}

export default function SessionBoard({ initialSessions }: { initialSessions: Session[] }) {
  const [sessions, setSessions] = useState(initialSessions);
  const [user, setUser] = useState<User | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState('');

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
    if (!user) {
      window.location.href = '/login';
      return;
    }
    if (user.kind === 'admin') {
      window.location.href = '/dashboard';
      return;
    }
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
    if (!user) return <Link className="button button-small button-ink" href="/login">Sign in to book</Link>;
    if (user.kind === 'admin') return <Link className="button button-small button-soft" href="/dashboard">Open desk</Link>;
    if (user.kind === 'coach' && session.coach_id === user.id) return <span className="session-action-note">Your session</span>;
    if (session.own_booking === 'active') return <button className="button button-small button-soft" disabled={busyId === session.id} onClick={() => cancel(session.id)}>{busyId === session.id ? 'Updating…' : 'Cancel booking'}</button>;
    return <button className="button button-small button-cobalt" disabled={busyId === session.id || session.places_remaining < 1} onClick={() => book(session.id)}>{busyId === session.id ? 'Booking…' : session.places_remaining < 1 ? 'Full' : 'Book a place'}</button>;
  }

  return (
    <>
      <div className="session-list">
        {sessions.length ? sessions.map((session) => (
          <article className="session-row" key={session.id}>
            <div><span className="session-tag">#{session.id} · {session.session_type}</span><div className="session-name">{session.discipline}</div></div>
            <div className="session-meta session-time">{dateFormat(session.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })}<br />{dateFormat(session.starts_at, { hour: 'numeric', minute: '2-digit' })}–{dateFormat(session.ends_at, { hour: 'numeric', minute: '2-digit' })}</div>
            <div className="session-meta session-room">{session.room_name}</div>
            <div className="session-places">{session.places_remaining} places<br /><span className="session-fee">{session.seat_fee_credits} credits</span></div>
            <div className="session-action">{action(session)}</div>
          </article>
        )) : <p className="empty-state">There are no sessions in the next fourteen days. Check back soon or ask the assistant.</p>}
      </div>
      {message && <p className="session-feedback" role="status">{message}</p>}
    </>
  );
}
