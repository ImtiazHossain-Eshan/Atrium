import { Router } from 'express';
import { createPasswordReset, hashPassword } from '../auth';
import { query } from '../db';
import { sendPasswordSetup } from '../notifications';
import crypto from 'node:crypto';

const router = Router();

router.post('/request', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (email) {
    const people = await query<{ id: number; email: string; active: boolean }>(
      'select id, email, active from person where lower(email) = $1',
      [email]
    );
    if (people[0]?.active) {
      const token = await createPasswordReset(people[0].id);
      await sendPasswordSetup(people[0].email, token);
    }
  }
  res.json({ message: 'If that email belongs to an active Atrium account, a password setup link has been sent.' });
});

router.post('/reset', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!token || password.length < 10) {
    res.status(400).json({ error: 'use a password with at least 10 characters' });
    return;
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await query<{ person_id: number }>(
    `update password_reset_token set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning person_id`,
    [tokenHash]
  );
  if (!result[0]) {
    res.status(400).json({ error: 'that password setup link is invalid or expired' });
    return;
  }
  await query('update person set password_hash = $1 where id = $2', [hashPassword(password), result[0].person_id]);
  res.json({ message: 'Password set. You can now sign in.' });
});

export default router;
