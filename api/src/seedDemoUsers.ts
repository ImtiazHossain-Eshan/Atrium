/**
 * Gives the three demo accounts a known password.
 *
 * The supplied seed stores unsalted SHA-256 hashes of passwords that were never
 * written down anywhere, so a marker cloning this repository could reach the
 * administrator and nobody else. Signing in as a participant, a coach and an
 * administrator is the second thing the brief asks to see working, so the
 * credentials for one of each are set here and published in the README.
 *
 * Every other seeded account keeps its original hash and is reached through the
 * password-reset flow. Nothing here weakens the hashing: these rows get the
 * same salted scrypt treatment as an account created through /signup.
 *
 * Run automatically by `npm run migrate`. Safe to run repeatedly.
 */
import { pool, query } from './db';
import { hashPassword } from './auth';

type DemoAccount = { label: string; kind: 'admin' | 'coach' | 'participant'; email: string; password: string };

const accounts: DemoAccount[] = [
  {
    label: 'administrator',
    kind: 'admin',
    email: (process.env.SEED_ADMIN_EMAIL || 'admin@atrium.local').toLowerCase(),
    password: process.env.SEED_ADMIN_PASSWORD || 'atrium-admin-demo'
  },
  {
    label: 'coach',
    kind: 'coach',
    email: (process.env.SEED_COACH_EMAIL || 'oscar.lindqvist@atrium.local').toLowerCase(),
    password: process.env.SEED_COACH_PASSWORD || 'atrium-coach-demo'
  },
  {
    label: 'participant',
    kind: 'participant',
    email: (process.env.SEED_PARTICIPANT_EMAIL || 'sofia.marino@atrium.local').toLowerCase(),
    password: process.env.SEED_PARTICIPANT_PASSWORD || 'atrium-participant-demo'
  }
];

async function main(): Promise<void> {
  for (const account of accounts) {
    const updated = await query<{ id: number; kind: string }>(
      'update person set password_hash = $1 where lower(email) = $2 and active = true returning id, kind',
      [hashPassword(account.password), account.email]
    );
    if (!updated[0]) {
      console.warn(`  ! ${account.label}: no active account for ${account.email}, skipped`);
      continue;
    }
    if (updated[0].kind !== account.kind) {
      console.warn(`  ! ${account.email} is a ${updated[0].kind}, not the expected ${account.kind}`);
    }
    console.log(`  ${account.label.padEnd(14)} ${account.email}`);
  }
  console.log('\nDemo passwords are the SEED_* values in .env (see README).');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('could not set demo credentials:', err.message);
    await pool.end();
    process.exit(1);
  });
