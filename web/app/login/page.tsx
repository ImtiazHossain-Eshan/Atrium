'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'We could not sign you in.');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('The sign-in service is unavailable. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <section className="auth-panel" aria-labelledby="login-heading">
        <span className="section-mark">One door, three roles</span>
        <h1 id="login-heading">Welcome back.</h1>
        <p>Sign in with the account you use at Atrium. Your role decides what you can see and do next.</p>
        <form className="form-stack" onSubmit={onSubmit}>
          {error && <p className="form-error" role="alert">{error}</p>}
          <label className="field">Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className="field">Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="button button-ink" disabled={busy}>{busy ? 'Checking…' : 'Sign in'}</button>
        </form>
        <p style={{ marginTop: 22, marginBottom: 0 }}><Link href="/reset-password" style={{ color: 'var(--plum)' }}>Set or reset a password</Link></p>
        <p style={{ marginTop: 12, marginBottom: 0 }}><Link href="/" style={{ color: 'var(--ink-soft)' }}>Back to public sessions</Link></p>
      </section>
    </main>
  );
}
