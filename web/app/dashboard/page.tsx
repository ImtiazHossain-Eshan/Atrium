'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import AssistantPanel from '../components/AssistantPanel';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
type User = { id: number; full_name: string; kind: 'admin' | 'coach' | 'participant'; credits: number };
type Dashboard = { role: User['kind']; stats: Record<string, number>; upcoming: any[] };
type Booking = { session_id: number; booking_status: string; discipline: string; session_type: string; starts_at: string; ends_at: string; room_name: string; coach_name: string; credits_charged: number; credits_refunded: number };

function dateTime(value: string) { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }

export default function DashboardPage() {
  const [user, setUser] = useState<User | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState('');
  const [bookingBusy, setBookingBusy] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${apiBaseUrl}/api/me`, { credentials: 'include' }),
      fetch(`${apiBaseUrl}/api/dashboard`, { credentials: 'include' }),
      fetch(`${apiBaseUrl}/api/bookings`, { credentials: 'include' })
    ]).then(async ([meResponse, dashboardResponse, bookingsResponse]) => {
      if (!meResponse.ok || !dashboardResponse.ok) { window.location.href = '/login'; return; }
      setUser(await meResponse.json());
      setDashboard(await dashboardResponse.json());
      setBookings(bookingsResponse.ok ? await bookingsResponse.json() : []);
    }).catch(() => setError('The dashboard could not load. Refresh to try again.'));
  }, []);

  async function cancelBooking(sessionId: number) {
    if (!window.confirm('Cancel this booking and apply the published refund policy?')) return;
    setBookingBusy(sessionId);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/bookings/${sessionId}/cancel`, { method: 'POST', credentials: 'include' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'That booking could not be cancelled.');
      setBookings((current) => current.map((booking) => booking.session_id === sessionId ? { ...booking, booking_status: 'cancelled', credits_refunded: payload.refund } : booking));
      setUser((current) => current ? { ...current, credits: current.credits + Number(payload.refund || 0) } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That booking could not be cancelled.');
    } finally {
      setBookingBusy(null);
    }
  }

  if (error && !user) return <main className="dashboard-shell"><p className="form-error" role="alert">{error}</p></main>;
  if (!user || !dashboard) return <main className="dashboard-shell"><p className="loading">Loading your Atrium desk…</p></main>;

  const stats = Object.entries(dashboard.stats);
  const heading = user.kind === 'admin' ? 'Centre overview.' : user.kind === 'coach' ? 'Your coaching desk.' : 'Your next good step.';
  const subhead = user.kind === 'admin' ? 'The whole room, with details available when you need them.' : user.kind === 'coach' ? 'Your sessions, attendees, and the room around you.' : 'Your bookings and balance, without someone else’s information mixed in.';
  const visibleBookings = bookings.filter((booking) => booking.booking_status === 'active' || new Date(booking.starts_at).getTime() > Date.now() - 86400000).slice(0, 4);

  return (
    <main className="dashboard-shell">
      <div className="dashboard-top">
        <div><span className="section-mark">{user.kind} dashboard</span><h1>{heading}</h1><p>{subhead}</p></div>
        <div className="dashboard-actions">
          <Link className="button button-plum" href="/dashboard/calendar">Open calendar</Link>
          {user.kind !== 'admin' && <a className="button button-soft" href="/#sessions">Find a session</a>}
          <Link className="button button-soft" href="/dashboard/assistant">Ask assistant</Link>
          {user.kind !== 'participant' && <Link className="button button-soft" href="/admin/sessions">Manage sessions</Link>}
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="stat-line">{stats.map(([key, value]) => <div className="stat" key={key}><strong>{value}</strong><span>{key.replaceAll('_', ' ')}</span></div>)}</div>

      <div className="dashboard-grid">
        <section className="panel" aria-labelledby="agenda-heading">
          <div className="panel-heading"><h2 id="agenda-heading">Next on your schedule</h2><Link href="/dashboard/calendar">View all</Link></div>
          {dashboard.upcoming.length ? dashboard.upcoming.map((item) => <div className="agenda-item" key={item.id || item.session_id}><div className="agenda-time">{dateTime(item.starts_at)}</div><div><div className="agenda-title">{item.discipline}</div><div className="agenda-sub">{item.room_name}{item.coach_name ? ` · ${item.coach_name}` : ''}{item.enrolled_count !== undefined ? ` · ${item.enrolled_count}/${item.capacity} places` : ''}</div></div><Link className="agenda-action" href={`/dashboard/calendar#session-${item.id || item.session_id}`}>Open</Link></div>) : <p className="empty-state">Nothing upcoming yet. Find a session on the public board.</p>}
        </section>

        <aside className="panel">
          <div className="panel-heading"><h2>{user.kind === 'admin' ? 'Keep the rules close' : 'Your bookings'}</h2></div>
          {user.kind === 'admin' ? <div className="role-note">Administrators can see all rooms, people, bookings, and attendance. The API applies that boundary before data reaches this screen.</div> : visibleBookings.length ? <div className="booking-list">{visibleBookings.map((booking) => <article className="booking-item" key={booking.session_id}><div><strong>{booking.discipline}</strong><span>{dateTime(booking.starts_at)} · {booking.room_name}</span></div>{booking.booking_status === 'active' ? <button className="link-button" disabled={bookingBusy === booking.session_id} onClick={() => cancelBooking(booking.session_id)}>{bookingBusy === booking.session_id ? 'Working…' : 'Cancel'}</button> : <span className="booking-cancelled">Cancelled · {booking.credits_refunded} cr back</span>}</article>)}</div> : <p className="empty-state">No bookings yet. Browse the live board to choose a place.</p>}
          <div className="role-note dashboard-rule-note">{user.kind === 'coach' ? 'You can see your attendee names on your own sessions. Other coaches’ sessions stay busy-only.' : 'Other participants never appear in your dashboard or assistant answers.'}</div>
          <div className="dashboard-aside-action"><Link className="button button-small button-moss" href="/#policies">Review fees and refund rules</Link></div>
        </aside>
      </div>

      <section className="section" style={{ paddingBottom: 0 }}><AssistantPanel /></section>
    </main>
  );
}
