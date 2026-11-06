import { Hono } from 'hono';
import { z } from 'zod';
import { dummyVerify, sha256Hex, verifyPassword, verifyTotpStep } from '../lib/crypto';
import { rowToUser, type UserRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import { completeAssertion, loginFailed, PasskeyAssertionSchema, prepareAssertion, relyingParty } from '../lib/passkeys';
import { clear, hit, unhit } from '../lib/ratelimit';
import { jsonBody } from '../lib/validate';
import { createSession, destroySession } from '../middleware/session';
import type { AppEnv } from '../types';

export const auth = new Hono<AppEnv>();

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_PER_IP_EMAIL = 10;
export const LOGIN_MAX_PER_EMAIL = 30;
export const TOTP_MAX_FAILURES = 5;

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(256),
  totp: z.string().trim().max(32).optional(),
  passkey: PasskeyAssertionSchema.optional(),
});

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const tooMany = () => new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again in 15 minutes.');

/**
 * Accepts a TOTP code (or a recovery code) for `user`, at most once per time step.
 * The conditional UPDATE on totp_last_step makes replay rejection atomic.
 */
export async function acceptSecondFactor(db: D1Database, user: UserRow, code: string, now: number): Promise<boolean> {
  const step = await verifyTotpStep(user.totp_secret ?? '', code, now);
  if (step !== null) {
    const res = await db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').bind(step, user.id, step).run();
    return res.meta.changes > 0;
  }
  // Recovery codes are single-use; the UPDATE ... used_at IS NULL claim makes that atomic.
  const hash = await sha256Hex(normalizeRecoveryCode(code));
  const res = await db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .bind(now, user.id, hash).run();
  return res.meta.changes > 0;
}

auth.post('/login', async (c) => {
  const body = await jsonBody(c, LoginSchema);
  const db = c.env.DB;
  const now = Date.now();
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const ipKey = `login:${ip}:${body.email}`;
  const emailKey = `login-email:${body.email}`;
  // Count the attempt before any hashing, so parallel requests cannot all slip under the cap.
  const [ipCount, emailCount] = await Promise.all([hit(db, ipKey, LOGIN_WINDOW_MS, now), hit(db, emailKey, LOGIN_WINDOW_MS, now)]);
  if (ipCount > LOGIN_MAX_PER_IP_EMAIL || emailCount > LOGIN_MAX_PER_EMAIL) throw tooMany();

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(body.email).first<UserRow>();
  if (!user) {
    await dummyVerify(body.password);
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (!(await verifyPassword(body.password, user.password_hash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (user.totp_secret && body.passkey) {
    // A passkey stands in for the TOTP code. Its attempts share the TOTP failure budget.
    const totpKey = `totp:${user.id}`;
    if ((await hit(db, totpKey, LOGIN_WINDOW_MS, now)) > TOTP_MAX_FAILURES) throw tooMany();
    const rp = relyingParty(c.req.url);
    const prepared = await prepareAssertion(db, body.passkey, rp, now);
    if (prepared.pk.user_id !== user.id) throw loginFailed();
    await completeAssertion(db, prepared, rp, false, now);
    await clear(db, totpKey);
  } else if (user.totp_secret) {
    if (!body.totp) {
      // The password was right: this attempt is not a guess, so give the hits back.
      await Promise.all([unhit(db, ipKey), unhit(db, emailKey)]);
      throw new HttpError(401, 'TOTP_REQUIRED', 'Enter the code from your authenticator app');
    }
    const totpKey = `totp:${user.id}`;
    if ((await hit(db, totpKey, LOGIN_WINDOW_MS, now)) > TOTP_MAX_FAILURES) throw tooMany();
    if (!(await acceptSecondFactor(db, user, body.totp, now))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'That authentication code is not valid');
    }
    await clear(db, totpKey);
  }
  if (user.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  await Promise.all([clear(db, ipKey), unhit(db, emailKey)]);
  await createSession(c, user.id);
  return c.json({ user: rowToUser(user) });
});

auth.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});
