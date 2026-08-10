import Link from 'next/link';
import AssistantPanel from './components/AssistantPanel';
import SessionBoard from './components/SessionBoardFoldable';
import TimePrism from './components/TimePrism';

export const dynamic = 'force-dynamic';
const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
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
};

async function loadSessions(): Promise<Session[]> {
  const from = new Date();
  const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
  try {
    const response = await fetch(`${apiBaseUrl}/api/sessions?from=${from.toISOString()}&to=${to.toISOString()}`, { cache: 'no-store' });
    return response.ok ? response.json() : [];
  } catch {
    return [];
  }
}

export default async function Home() {
  const sessions = await loadSessions();
  return (
    <main>
      <div className="page-shell">
        <section className="public-hero">
          <div>
            <span className="section-mark">Coaching, on the record</span>
            <h1 className="hero-title">Make room for the work that <em>moves you.</em></h1>
            <p className="hero-lede">Twelve rooms. One clear record of what it costs, where it happens, and who can book it.</p>
            <div className="hero-actions">
              <a className="button button-plum" href="#sessions">Browse sessions</a>
              <Link className="button button-soft" href="/login">Member sign in</Link>
            </div>
          </div>
          <div className="hero-visual">
            <TimePrism />
            <aside className="hero-note" aria-label="Centre hours and booking note">
              <strong>07:00–21:00</strong>
              <p>Monday to Saturday · America/New_York · closed Sundays</p>
              <ul className="rule-list">
                <li>Short, standard, and intensive sessions</li>
                <li>Credits stay whole and visible</li>
              </ul>
            </aside>
          </div>
        </section>

        <section className="section" id="sessions" aria-labelledby="sessions-heading">
          <div className="section-heading">
            <div><span className="section-mark">Next on the board</span><h2 id="sessions-heading">Upcoming sessions</h2></div>
            <p>Places and prices are live. Session times are shown in the centre’s New York timezone.</p>
          </div>
          <SessionBoard initialSessions={sessions} />
        </section>

        <section className="section policy-section" id="policies" aria-labelledby="policy-heading">
          <div className="section-heading"><span className="section-mark">Before you book</span><h2 id="policy-heading">The rules, without the fog.</h2><p>Credits are whole-number account units. Open a line when you need the detail; the essentials stay visible.</p></div>
          <div>
            <div className="fee-strip" aria-label="Fee schedule">
              <div className="fee-item"><strong>30 / 15</strong><span>Short · room / place</span></div>
              <div className="fee-item"><strong>40 / 20</strong><span>Standard · room / place</span></div>
              <div className="fee-item"><strong>120 / 60</strong><span>Intensive · room / place</span></div>
            </div>
            <div className="policy-accordion">
              <details open>
                <summary><strong>Coach bookings</strong><span>48-hour deadline · 100 / 50 / 25 / 0% refunds</span></summary>
                <p>Coaches spend the room fee and must book at least 48 hours before start. The refund tier is measured in absolute hours from cancellation.</p>
              </details>
              <details>
                <summary><strong>Participant bookings</strong><span>Same notice tiers · rounded down</span></summary>
                <p>Participants use the same 96+ / 48–&lt;96 / 24–&lt;48 / under 24-hour tiers. Refunds round down to whole credits.</p>
              </details>
              <details>
                <summary><strong>If a coach cancels</strong><span>Participants get 100% back</span></summary>
                <p>Affected participants receive a full place-fee refund, regardless of notice. The room is released and the session leaves active calendars.</p>
              </details>
              <details>
                <summary><strong>Session shape</strong><span>45 / 60 / 210-minute room holds</span></summary>
                <p>Short is 45 minutes, standard is 60, and intensive is 180 minutes of teaching with a 30-minute interval; the room is held for 210 minutes.</p>
              </details>
            </div>
          </div>
        </section>

        <section className="section"><AssistantPanel /></section>
        <footer className="footer">Atrium Coaching Centre · Twelve rooms · Monday–Saturday · America/New_York</footer>
      </div>
    </main>
  );
}
