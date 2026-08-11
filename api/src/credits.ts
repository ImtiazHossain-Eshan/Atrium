export const SESSION_TYPES = ['short', 'standard', 'intensive'] as const;

/**
 * What an account is issued when it is created.
 *
 * Stated here rather than inline at each creation site so there is one place
 * that answers "where does 4000 come from". Only participants are created by
 * the application today, through /signup and through the assistant's visitor
 * booking; coaches arrive with the seed. The coach figure is carried anyway so
 * that a coach-creation route added later cannot quietly invent its own.
 */
export const OPENING_CREDITS: Record<'participant' | 'coach' | 'admin', number> = {
  participant: 4000,
  coach: 2000,
  admin: 0
};

const ROOM_FEES: Record<string, number> = {
  short: 30,
  standard: 40,
  intensive: 120
};

const SEAT_FEES: Record<string, number> = {
  short: 15,
  standard: 20,
  intensive: 60
};

export function roomFee(sessionType: string): number {
  return ROOM_FEES[sessionType] ?? 0;
}

export function seatFee(sessionType: string): number {
  return SEAT_FEES[sessionType] ?? 0;
}

export function sessionDurationMinutes(sessionType: string): number {
  if (sessionType === 'short') return 45;
  if (sessionType === 'standard') return 60;
  if (sessionType === 'intensive') return 210;
  return 0;
}

export function hoursOfNotice(cancelledAt: Date, startsAt: Date): number {
  return Math.max(0, startsAt.getTime() - cancelledAt.getTime()) / (1000 * 60 * 60);
}

export function refundPercent(hoursNotice: number): number {
  if (hoursNotice >= 96) return 1;
  if (hoursNotice >= 48) return 0.5;
  if (hoursNotice >= 24) return 0.25;
  return 0;
}

export function refundAmount(fee: number, percent: number): number {
  return Math.floor(fee * percent);
}
