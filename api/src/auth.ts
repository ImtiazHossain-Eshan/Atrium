import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { query, withTransaction } from './db';

export type Role = 'admin' | 'coach' | 'participant';
export type CurrentUser = {
  id: number;
  email: string;
  full_name: string;
  kind: Role;
  credits: number;
  active: boolean;
};

export const SESSION_COOKIE = 'atrium_session';
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;

function sessionTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function timingSafeMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return `scrypt$32768$8$1$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null): { valid: boolean; legacy: boolean } {
  if (!stored) return { valid: false, legacy: false };

  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, salt, expected] = stored.split('$');
    if (!n || !r || !p || !salt || !expected) return { valid: false, legacy: false };
    const actual = crypto.scryptSync(password, salt, 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024
    }).toString('hex');
    return { valid: timingSafeMatch(actual, expected), legacy: false };
  }

  // Compatibility for the supplied seed. A successful login upgrades the row
  // immediately to scrypt; new accounts never use this path.
  const legacyHash = crypto.createHash('sha256').update(password).digest('hex');
  return { valid: timingSafeMatch(legacyHash, stored), legacy: true };
}

export async function createSession(personId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `insert into app_session (person_id, token_hash, expires_at)
     values ($1, $2, now() + interval '12 hours')`,
    [personId, sessionTokenHash(token)]
  );
  return token;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function getUserFromRequest(req: Request): Promise<CurrentUser | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const users = await query<CurrentUser>(
    `select p.id, p.email, p.full_name, p.kind, p.credits, p.active
       from app_session s
       join person p on p.id = s.person_id
      where s.token_hash = $1 and s.expires_at > now() and p.active = true`,
    [sessionTokenHash(token)]
  );
  if (users.length === 0) return null;
  await query('update app_session set last_seen_at = now() where token_hash = $1', [sessionTokenHash(token)]);
  return users[0];
}

export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.locals.user = user;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not verify the session' });
  }
}

export function requireRole(...roles: Role[]) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const user = res.locals.user as CurrentUser | undefined;
    if (!user || !roles.includes(user.kind)) {
      res.status(403).json({ error: 'you are not allowed to do that' });
      return;
    }
    next();
  };
}

export async function login(req: Request, res: Response): Promise<void> {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    const people = await query<CurrentUser & { password_hash: string | null }>(
      `select id, email, full_name, kind, credits, active, password_hash
         from person where lower(email) = $1`,
      [email]
    );
    const person = people[0];
    if (!person || !person.active || !verifyPassword(password, person.password_hash).valid) {
      res.status(401).json({ error: 'email or password is incorrect' });
      return;
    }

    if (verifyPassword(password, person.password_hash).legacy) {
      await query('update person set password_hash = $1 where id = $2', [hashPassword(password), person.id]);
    }

    const token = await createSession(person.id);
    setSessionCookie(res, token);
    res.json({ id: person.id, email: person.email, full_name: person.full_name, kind: person.kind });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not sign in' });
  }
}

export async function signup(req: Request, res: Response): Promise<void> {
  const fullName = typeof req.body?.full_name === 'string' ? req.body.full_name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (fullName.length < 2 || fullName.length > 120) {
    res.status(400).json({ error: 'Enter a name between 2 and 120 characters.' });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  if (password.length < 8 || password.length > 200) {
    res.status(400).json({ error: 'Use a password between 8 and 200 characters.' });
    return;
  }

  try {
    const token = crypto.randomBytes(32).toString('base64url');
    const person = await withTransaction(async (client) => {
      const inserted = await client.query<CurrentUser>(
        `insert into person (email, password_hash, full_name, kind, credits, active, created_at)
         values ($1, $2, $3, 'participant', 4000, true, now())
         returning id, email, full_name, kind, credits, active`,
        [email, hashPassword(password), fullName]
      );
      const created = inserted.rows[0];
      await client.query(
        `insert into app_session (person_id, token_hash, expires_at)
         values ($1, $2, now() + interval '12 hours')`,
        [created.id, sessionTokenHash(token)]
      );
      return created;
    });

    setSessionCookie(res, token);
    res.status(201).json({ id: person.id, email: person.email, full_name: person.full_name, kind: person.kind });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'An account with that email already exists. Sign in or reset your password.' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Could not create your account. Try again in a moment.' });
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await query('delete from app_session where token_hash = $1', [sessionTokenHash(token)]);
  clearSessionCookie(res);
  res.json({ signed_out: true });
}

export async function me(_req: Request, res: Response): Promise<void> {
  res.json(res.locals.user);
}

export async function createPasswordReset(personId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await withTransaction(async (client) => {
    await client.query('delete from password_reset_token where person_id = $1 and used_at is null', [personId]);
    await client.query(
      `insert into password_reset_token (person_id, token_hash, expires_at)
       values ($1, $2, now() + interval '30 minutes')`,
      [personId, sessionTokenHash(token)]
    );
  });
  return token;
}
