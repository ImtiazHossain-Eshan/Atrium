'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export default function ResetPassword() {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') || ''); }, []);

  async function request(event: FormEvent) {
    event.preventDefault(); setError('');
    const response = await fetch(`${apiBaseUrl}/api/password/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const payload = await response.json(); setMessage(payload.message || 'Check your inbox.');
  }

  async function reset(event: FormEvent) {
    event.preventDefault(); setError('');
    const response = await fetch(`${apiBaseUrl}/api/password/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) });
    const payload = await response.json();
    if (!response.ok) { setError(payload.error || 'That link could not be used.'); return; }
    setMessage(payload.message); setPassword('');
  }

  return (
    <main className="auth-wrap">
      <section className="auth-panel" aria-labelledby="reset-heading">
        <span className="section-mark">Secure account access</span>
        <h1 id="reset-heading">Set your password.</h1>
        <p>Request a short-lived link by email, or paste the token from the local mail inbox.</p>
        {message && <p className="role-note" role="status">{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <form className="form-stack" onSubmit={request}>
          <label className="field">Account email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <button className="button button-soft">Email me a link</button>
        </form>
        <div style={{ borderTop: '1px solid var(--line)', margin: '26px 0', paddingTop: 20 }}>
          <form className="form-stack" onSubmit={reset}>
            <label className="field">Setup token<input value={token} onChange={(event) => setToken(event.target.value)} /></label>
            <label className="field">New password<input type="password" minLength={10} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <button className="button button-ink">Save password</button>
          </form>
        </div>
        <Link href="/login" style={{ color: 'var(--plum)' }}>Back to sign in</Link>
      </section>
    </main>
  );
}
