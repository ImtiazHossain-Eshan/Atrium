export default function TimePrism() {
  return (
    <figure className="hero-object" aria-label="Atrium's room and time system represented as a floating three-dimensional schedule block">
      <div className="object-stage" aria-hidden="true">
        <span className="object-kicker">ROOM / TIME / RECORD</span>
        <span className="object-orbit object-orbit-a" />
        <span className="object-orbit object-orbit-b" />
        <div className="time-block">
          <span className="time-face time-face-front">
            <small>ATRIUM // LIVE BOARD</small>
            <strong>Make room<br />for the work.</strong>
            <em>12 rooms · local time</em>
          </span>
          <span className="time-face time-face-top" />
          <span className="time-face time-face-side" />
        </div>
        <span className="object-tick object-tick-one">07:00</span>
        <span className="object-tick object-tick-two">21:00</span>
      </div>
      <figcaption><span className="object-status" /> The schedule stays legible when the day gets full.</figcaption>
    </figure>
  );
}
