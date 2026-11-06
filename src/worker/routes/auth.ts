import { Hono } from 'hono';
import { z } from 'zod';
import { dummyVerify, sha256Hex, verifyPassword, verifyTotp } from '../lib/crypto';
import { rowToUser, type UserRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import { jsonBody } from '../lib/validate';
import { createSession, destroySession } from '../middleware/session';
import type { AppEnv } from '../types';

export const auth = new Hono<AppEnv>();

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(256),
  totp: z.string().trim().max(32).optional(),
});

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function recordFailure(db: D1Database, key: string, now: number) {
  await db.prepare(
    `INSERT INTO rate_limits (key, count, window_end) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_end < ?3 THEN 1 ELSE count + 1 END,
       window_end = CASE WHEN window_end < ?3 THEN ?2 ELSE window_end END`,
  ).bind(key, now + LOGIN_WINDOW_MS, now).run();
}

auth.post('/login', async (c) => {
  const body = await jsonBody(c, LoginSchema);
  const now = Date.now();
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const key = `login:${ip}:${body.email}`;
  const rl = await c.env.DB.prepare('SELECT count, window_end FROM rate_limits WHERE key = ?').bind(key).first<{ count: number; window_end: number }>();
  if (rl && rl.window_end >= now && rl.count >= LOGIN_MAX_FAILURES) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Try again in 15 minutes.');
  }
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(body.email).first<UserRow>();
  if (!user) {
    await dummyVerify(body.password);
    await recordFailure(c.env.DB, key, now);
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (!(await verifyPassword(body.password, user.password_hash))) {
    await recordFailure(c.env.DB, key, now);
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (user.totp_secret) {
    if (!body.totp) throw new HttpError(401, 'TOTP_REQUIRED', 'Enter the code from your authenticator app');
    let ok = await verifyTotp(user.totp_secret, body.totp, now);
    if (!ok) {
      // Recovery codes are single-use; the UPDATE ... used_at IS NULL claim makes that atomic.
      const hash = await sha256Hex(normalizeRecoveryCode(body.totp));
      const res = await c.env.DB.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .bind(now, user.id, hash).run();
      ok = res.meta.changes > 0;
    }
    if (!ok) {
      await recordFailure(c.env.DB, key, now);
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'That authentication code is not valid');
    }
  }
  if (user.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  await c.env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
  await createSession(c, user.id);
  return c.json({ user: rowToUser(user) });
});

auth.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});
