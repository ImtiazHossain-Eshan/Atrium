'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const timezone = 'America/New_York';

type AssistantSession = {
  id: number;
  discipline: string;
  session_type: string;
  starts_at: string;
  ends_at: string;
  room_name: string;
  capacity: number;
  places_remaining: number;
  seat_fee_credits: number;
};

type Turn = {
  role: 'you' | 'assistant';
  text: string;
  sessions?: AssistantSession[];
};

function when(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}

const openingTurn: Turn = {
  role: 'assistant',
  text:
    'Ask me what is running, when, and what it costs. Sign in and I can also report your balance, take a booking, or cancel one. ' +
    'I answer as whoever is signed in, so the same question gets a different answer for a visitor, a participant and a coach.'
};

export default function AssistantPanel() {
  const [turns, setTurns] = useState<Turn[]>([openingTurn]);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [needsEmail, setNeedsEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);

  /**
   * Keeps the newest turn in view by scrolling the transcript box, not the page.
   *
   * This used to call scrollIntoView on a marker element, which scrolls every
   * scrollable ancestor, including the document. Because the effect also runs
   * on mount, simply loading the public page dragged the whole window down to
   * wherever the panel happened to sit.
   *
   * Setting scrollTop on the container touches nothing outside it, and the
   * first run is skipped so an untouched panel never moves at all.
   */
  const turnsShown = useRef(turns.length);
  useEffect(() => {
    // Gated on the transcript actually growing rather than on "has this run
    // before": in development React mounts effects twice, which defeats a
    // first-run flag and scrolls a panel nobody has touched.
    if (turns.length === turnsShown.current) return;
    turnsShown.current = turns.length;
    const box = transcript.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const asked = message.trim();
    if (!asked || busy) return;

    setTurns((current) => [...current, { role: 'you', text: asked }]);
    setMessage('');
    setBusy(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: asked, email: email || undefined })
      });
      const payload = await response.json();
      const answer = payload.answer || payload.error || 'I could not find an answer to that.';
      // The visitor-booking path asks for an address only when it needs one,
      // rather than showing an email box to everyone from the start.
      setNeedsEmail(/email address/i.test(answer));
      setTurns((current) => [...current, { role: 'assistant', text: answer, sessions: payload.sessions }]);
    } catch {
      setTurns((current) => [
        ...current,
        { role: 'assistant', text: 'The assistant is offline right now. You can still browse the session board or sign in.' }
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="assistant-panel" aria-labelledby="assistant-heading">
      <div className="assistant-copy">
        <span className="section-mark">Atrium assistant</span>
        <h2 id="assistant-heading">A useful answer, from the right point of view.</h2>
        <p>Ask anonymously about upcoming sessions. Sign in when you need your balance, your bookings, or coach-level detail.</p>
      </div>

      <div className="assistant-conversation" aria-live="polite" aria-busy={busy} ref={transcript}>
        {turns.map((turn, index) => (
          <div key={index} className={`assistant-turn assistant-turn-${turn.role}`}>
            <span className="assistant-label">{turn.role === 'you' ? 'You' : 'Atrium'}</span>
            <p>{turn.text}</p>
            {turn.sessions && turn.sessions.length > 0 && (
              <ul className="assistant-sessions">
                {turn.sessions.slice(0, 8).map((session) => (
                  <li key={session.id} className="assistant-session">
                    <span className="assistant-session-when">{when(session.starts_at)}</span>
                    <span className="assistant-session-what">
                      <strong>#{session.id} {session.discipline}</strong>
                      <em>{session.room_name} · {session.session_type}</em>
                    </span>
                    <span className="assistant-session-places">
                      <strong>{session.places_remaining}</strong>
                      <em>of {session.capacity} left · {session.seat_fee_credits} cr</em>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {busy && (
          <div className="assistant-turn assistant-turn-assistant">
            <span className="assistant-label">Atrium</span>
            <p>Checking the live schedule…</p>
          </div>
        )}
      </div>

      <form className="assistant-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="assistant-message">Your question</label>
        <input
          id="assistant-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="e.g. What sessions have places left?"
          disabled={busy}
          autoComplete="off"
        />
        {needsEmail && (
          <>
            <label className="sr-only" htmlFor="assistant-email">Email address for a new account</label>
            <input
              id="assistant-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Your email address"
              disabled={busy}
              autoComplete="email"
            />
          </>
        )}
        <button className="button button-plum" disabled={busy || !message.trim()}>
          {busy ? 'Working…' : 'Ask assistant'}
        </button>
      </form>
    </section>
  );
}
