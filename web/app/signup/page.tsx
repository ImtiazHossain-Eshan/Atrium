'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export default function Signup() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ full_name: fullName, email, password })
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || 'We could not create your account.');
        return;
      }
      window.dispatchEvent(new Event('atrium-auth-changed'));
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('The sign-up service is unavailable. Make sure the Atrium service is running and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <section className="auth-panel" aria-labelledby="signup-heading">
        <span className="section-mark">Start with your own account</span>
        <h1 id="signup-heading">Make a place at Atrium.</h1>
        <p>Create a participant account to book sessions, manage cancellations, and keep your credit balance in one place.</p>
        <form className="form-stack" onSubmit={onSubmit}>
          {error && <p className="form-error" role="alert">{error}</p>}
          <label className="field">Full name<input type="text" autoComplete="name" required minLength={2} maxLength={120} value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
          <label className="field">Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className="field">Password<input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /><span className="field-hint">At least 8 characters.</span></label>
          <button className="button button-ink" disabled={busy}>{busy ? 'Creating account…' : 'Create participant account'}</button>
        </form>
        <p style={{ marginTop: 22, marginBottom: 0 }}>Already have an account? <Link href="/login" style={{ color: 'var(--plum)' }}>Sign in</Link></p>
        <p style={{ marginTop: 12, marginBottom: 0 }}><Link href="/" style={{ color: 'var(--ink-soft)' }}>Back to public sessions</Link></p>
      </section>
    </main>
  );
}
