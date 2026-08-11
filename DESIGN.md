# Atrium visual system

## Direction

Atrium is a poster wall for room, time, and money. The assigned surreal film-poster direction is translated into a useful scheduling surface: off-white stock, graphite ink, plum hierarchy, citron availability marks, and poppy warnings. Its signature object is a readable paper volume that makes the schedule feel physical without turning the booking flow into a toy.

## Tokens

- Paper: `#f5efe3`
- Deep paper: `#ebe1cf`
- Cream paper: `#fffaf0`
- Graphite ink: `#28232a`
- Soft ink: `#665b63`
- Rule: `#d7cbbd`
- Citron: `#bdca55` / `#edf2c8`
- Plum: `#6d3159` / `#ecdae5`
- Poppy: `#a63b50` / `#f2dce0`
- Night stage: `#28242a`
- Elevation: `0 14px 30px rgba(40, 35, 42, .1)`
- Radius: 7px controls, 16px authored surfaces, nearly square ruled lists

## Typography

Body copy uses a humanist sans fallback stack. Headings use a restrained book serif. Tracked uppercase labels act as wayfinding, while the time object uses compact operational notation as part of the printed-poster grammar.

## Surfaces and components

- Sticky paper header with compact mobile navigation and role-aware account actions.
- Atrium wordmark pairs a plum atrium-roof emblem with the full Coaching Centre name and is reused as the app icon.
- Public hero pairs a short promise with a CSS 3D schedule print: cream front face, citron top plane, poppy side plane, orbit marks, and centre-local time ticks. The composition is upright enough to read at a glance.
- Upcoming sessions are grouped into foldable day boards. The first board opens by default, later days stay compact, and a load-more control reveals the next three days without forcing a long scroll. Each row gives the time, discipline, room, places, price, session type, and the next action in a single scan path.
- Header navigation uses quiet pill links and a plum member CTA so account actions read as actions rather than loose text.
- Type bars use plum for standard, citron for short, and poppy for intensive sessions; the palette is deliberately free of blue.
- Fee schedule stays visible, while four policy details use progressive disclosure so the booking contract remains findable without becoming a wall of copy.
- Dashboard shows personal bookings and cancellation/refund feedback. Coach and administrator desks support room booking, moving, cancelling, and attendee-aware management within API role boundaries.
- Forms use semantic labels, visible focus, inline error blocks, explicit loading text, and keyboard-operable actions.
- Public auth keeps one clear path from sign-in to participant signup; a successful signup starts a session so the next action is booking, not another credential screen.

## Responsive behavior

The public composition becomes one column at 800px. Session boards preserve the day grouping, then reflow each row into time, session identity, availability, and action blocks at 800px and 560px. At 360px, actions become full-width touch targets and the 3D print scales down without clipping. Policy summaries, dashboard booking rows, and session-management controls wrap into vertical flows. Safe-area padding and reduced-motion behavior are included.

## Motion and interaction

The schedule print has one authored floating moment and the hero copy has a short entrance on fine pointers. Reduced-motion users receive the same visible geometry without animation. Booking, cancellation, move, loading, error, empty, and permission states are text-labelled and keyboard-operable.

## Review notes

The public page was reviewed for the mobile border-spacing issue, the former blue palette, the overly dense policy copy, the flat session list, direct booking and cancellation actions, and the role-aware management paths. The calendar distinguishes a coach's own sessions from other coaches' busy periods by weight rather than by colour alone, so the distinction survives a greyscale print and a colour-vision difference.
