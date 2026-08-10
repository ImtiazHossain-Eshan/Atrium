'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type User = { full_name: string; kind: 'admin' | 'coach' | 'participant'; credits: number };
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export default function Header() {
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/me`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  async function signOut() {
    await fetch(`${apiBaseUrl}/api/logout`, { method: 'POST', credentials: 'include' });
    setUser(null);
    window.location.href = '/';
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" href="/" aria-label="Atrium Coaching Centre home">
          <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M7 32 20 7l13 25" /><path d="M11 32h18M14 26h12M17 20h6" /></svg></span>
          <span className="brand-wordmark"><strong>Atrium</strong><small>Coaching Centre</small></span>
        </Link>
        <button className="menu-toggle" type="button" aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setMenuOpen((open) => !open)}>
          <span>{menuOpen ? 'Close' : 'Menu'}</span>
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d={menuOpen ? 'M4 4 16 16M16 4 4 16' : 'M3 5h14M3 10h14M3 15h14'} /></svg>
        </button>
        <nav id="primary-navigation" className={`site-nav${menuOpen ? ' is-open' : ''}`} aria-label="Primary navigation">
          <Link href="/" onClick={closeMenu}>Sessions</Link>
          <a href="/#policies" onClick={closeMenu}>Policies</a>
          {user && <Link className="nav-link nav-link-action" href="/dashboard" onClick={closeMenu}>Dashboard</Link>}
          <div className="mobile-nav-account">
            {user ? <button className="link-button" onClick={signOut}>Sign out</button> : <Link className="button button-small button-ink" href="/login" onClick={closeMenu}>Member sign in</Link>}
          </div>
        </nav>
        <div className="header-account">
          {user ? (
            <>
              <span className="account-chip"><span className="status-dot" />{user.full_name} · {user.credits} cr</span>
              <button className="link-button" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <Link className="button button-small button-ink" href="/login">Member sign in</Link>
          )}
        </div>
      </div>
    </header>
  );
}
