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
          <div className="section-heading"><span className="section-mark">Before you book</span><h2 id="policy-heading">The rules, without the fog.</h2><p>Everything on this page is enforced by the system, not by goodwill. Read the refund tiers before you book: after that, the clock decides.</p></div>
          <div>
            <div className="fee-strip" aria-label="Fee schedule">
              <div className="fee-item"><strong>30 / 15</strong><span>Short · room / place</span></div>
              <div className="fee-item"><strong>40 / 20</strong><span>Standard · room / place</span></div>
              <div className="fee-item"><strong>120 / 60</strong><span>Intensive · room / place</span></div>
            </div>

            <p className="policy-lede">
              Atrium runs on <strong>credits</strong>, not currency. A new participant account starts with <strong>4000 credits</strong> and a
              new coach account with <strong>2000</strong>. Credits are whole numbers, they are not bought or cashed out, and the figures above
              are what a booking costs: the left number is what a coach pays to hold the room, the right is what you pay for a place in it.
            </p>

            <div className="policy-accordion">
              <details open>
                <summary><strong>Cancelling your place</strong><span>100 / 50 / 25 / 0% by notice given</span></summary>
                <p>
                  What you get back depends on how far ahead of the start time you cancel — measured in real hours, from the moment you
                  cancel, not in calendar days:
                </p>
                <ul className="rule-list">
                  <li><strong>96 hours or more</strong> — all 100% of the place fee</li>
                  <li><strong>48 to under 96 hours</strong> — 50%</li>
                  <li><strong>24 to under 48 hours</strong> — 25%</li>
                  <li><strong>Under 24 hours</strong> — nothing</li>
                </ul>
                <p>
                  Part-credits round <strong>down</strong>: cancelling a 15-credit place at the 25% tier returns 3 credits, not 4. Cancelling
                  after the session has started is treated as under 24 hours. <strong>Not turning up is not a cancellation</strong> — if you
                  do not cancel, you keep the booking and lose the fee.
                </p>
              </details>

              <details>
                <summary><strong>If the coach cancels</strong><span>You get 100% back, always</span></summary>
                <p>
                  The notice tiers do not apply to you when a coach cancels. You did nothing wrong, so the full place fee returns to your
                  account whether the cancellation comes three weeks or three minutes beforehand, and we email you when it happens.
                </p>
              </details>

              <details>
                <summary><strong>When you can book</strong><span>Any time until the session starts</span></summary>
                <p>
                  There is no deadline on booking a place: if a session has a place left, you can take it right up to the moment it starts.
                  Be aware that a booking made inside 24 hours is already in the 0% refund tier — you can book it, but you cannot get the
                  fee back if you change your mind. <em>Coaches</em> booking a room have a different rule and must book at least 48 hours
                  ahead.
                </p>
              </details>

              <details>
                <summary><strong>One place at a time</strong><span>Overlapping bookings are refused</span></summary>
                <p>
                  Nobody can be in two rooms at once, so a booking that overlaps something you are already committed to will be refused
                  rather than accepted and charged. A session ending at 10:00 and one starting at 10:00 do not overlap, so you can take both.
                </p>
                <p>
                  An <strong>intensive</strong> holds you for its whole 210-minute block, including the 30-minute interval in the middle. You
                  cannot book anything else during that interval, in any room — the break belongs to the session.
                </p>
              </details>

              <details>
                <summary><strong>Session shape and opening hours</strong><span>45 / 60 / 210-minute room holds</span></summary>
                <p>
                  Short is 45 minutes and standard is 60. An intensive teaches for 180 minutes with a 30-minute interval, so the room is held
                  for 210. Every session runs inside <strong>07:00–21:00, Monday to Saturday</strong>, in the centre's own New York time —
                  every time shown on this site is New York time, wherever you are reading it. The centre is closed on Sundays.
                </p>
              </details>

              <details>
                <summary><strong>Places and capacity</strong><span>First come, no waiting list</span></summary>
                <p>
                  Each room has a fixed capacity, counting participants only — the coach does not take a place. When the places shown against
                  a session reach zero it is full, and there is no waiting list: if someone cancels, the place returns to the board for
                  whoever takes it first.
                </p>
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
