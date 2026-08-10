'use client';

import { FormEvent, useState } from 'react';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export default function AssistantPanel() {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [answer, setAnswer] = useState('Ask about sessions, your balance, or say “book session 123”.');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message, email: email || undefined })
      });
      const payload = await response.json();
      setAnswer(payload.answer || payload.error || 'I could not find an answer.');
      setMessage('');
    } catch {
      setAnswer('The assistant is offline right now. You can still browse the session list or sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="assistant-panel" aria-labelledby="assistant-heading">
      <div className="assistant-copy">
        <span className="section-mark">Atrium assistant</span>
        <h2 id="assistant-heading">A useful answer, from the right point of view.</h2>
        <p>Ask anonymously about upcoming sessions. Sign in when you need your balance, bookings, or coach-level detail.</p>
      </div>
      <div className="assistant-conversation" aria-live="polite"><span className="assistant-label">Response</span><p>{busy ? 'Checking the live schedule…' : answer}</p></div>
      <form className="assistant-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="assistant-message">Your question</label>
        <input id="assistant-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="e.g. What sessions have places left?" disabled={busy} />
        <label className="sr-only" htmlFor="assistant-email">Email for a new visitor booking</label>
        <input id="assistant-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email only if booking as a visitor" disabled={busy} />
        <button className="button button-plum" disabled={busy || !message.trim()}>{busy ? 'Working…' : 'Ask assistant'}</button>
      </form>
    </section>
  );
}
