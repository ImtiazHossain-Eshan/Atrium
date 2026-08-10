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
      <body data-impeccable-seed="bf581493">
        {/* THESIS: Atrium turns room, time, and money into one legible booking record; it refuses the generic card-grid landing page. OWN-WORLD: off-white poster stock, graphite ink, plum type, citron status marks, and poppy edges create a printed scheduling language with a readable paper volume as its signature object. STORY: visitors understand the board, trust the rules, and book without guessing. FIRST VIEWPORT: an upright 3D schedule print anchors the promise while grouped day boards and direct booking actions make the next choice obvious. FORM: surreal film-poster composition translated into a functional schedule wall, assigned direction index 6, seed bf581493. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md */}
        <Header />
        {children}
      </body>
    </html>
  );
}
