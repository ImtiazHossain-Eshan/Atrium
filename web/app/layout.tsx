import type { Metadata, Viewport } from 'next';
import './globals.css';
import Header from './components/Header';

export const metadata: Metadata = {
  title: 'Atrium Coaching Centre',
  description: 'Book coaching rooms and places with clear rules, credits, and role-aware support.'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/*
        Browser extensions write their own attributes onto <body> before React
        hydrates — ColorZilla adds cz-shortcut-listen, password managers and
        grammar checkers do similar. The server sends a bare <body>, so React
        reports the difference as a hydration mismatch that is not ours and
        cannot be fixed from here.

        suppressHydrationWarning applies to this element's own attributes only,
        one level deep. It does not reach the children, so a genuine mismatch
        anywhere inside the app is still reported.
      */}
      <body suppressHydrationWarning>
        <Header />
        {children}
      </body>
    </html>
  );
}
