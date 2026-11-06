import { Hono } from 'hono';
import { z } from 'zod';
import { rowToUser, type UserRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import { authenticationOptions, completeAssertion, loginFailed, PasskeyAssertionSchema, prepareAssertion, relyingParty } from '../lib/passkeys';
import { clear, hit, unhit } from '../lib/ratelimit';
import { jsonBody } from '../lib/validate';
import { createSession } from '../middleware/session';
import type { AppEnv } from '../types';
import { LOGIN_MAX_PER_EMAIL, LOGIN_MAX_PER_IP_EMAIL, LOGIN_WINDOW_MS } from './auth';

// Pre-auth routes for passkey sign-in. Limits mirror password login: per IP and per account.
export const passkeyAuth = new Hono<AppEnv>();

const OPTIONS_MAX_PER_IP = 30;
const tooMany = () => new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again in 15 minutes.');

/** Hands out a single-use challenge. Always usernameless (discoverable credentials), so it says nothing about any account. */
passkeyAuth.post('/options', async (c) => {
  const body = await jsonBody(c, z.object({ mfa: z.boolean().optional() }));
  const db = c.env.DB;
  const now = Date.now();
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if ((await hit(db, `passkey-options:${ip}`, LOGIN_WINDOW_MS, now)) > OPTIONS_MAX_PER_IP) throw tooMany();
  return c.json({ options: await authenticationOptions(db, relyingParty(c.req.url), body.mfa === true, now) });
});

/** Passwordless sign-in. The passkey must prove user verification, which makes it multi-factor, so TOTP is skipped. */
passkeyAuth.post('/login', async (c) => {
  const body = await jsonBody(c, z.object({ credential: PasskeyAssertionSchema }));
  const db = c.env.DB;
  const now = Date.now();
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const ipKey = `passkey-login:${ip}`;
  // Count before any verification work, as password login does.
  if ((await hit(db, ipKey, LOGIN_WINDOW_MS, now)) > LOGIN_MAX_PER_IP_EMAIL) throw tooMany();

  const rp = relyingParty(c.req.url);
  const prepared = await prepareAssertion(db, body.credential, rp, now);
  const userKey = `passkey-user:${prepared.pk.user_id}`;
  if ((await hit(db, userKey, LOGIN_WINDOW_MS, now)) > LOGIN_MAX_PER_EMAIL) throw tooMany();
  const userId = await completeAssertion(db, prepared, rp, true, now);

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
  if (!user) throw loginFailed();
  if (user.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  await Promise.all([clear(db, ipKey), unhit(db, userKey)]);
  await createSession(c, user.id);
  return c.json({ user: rowToUser(user) });
});
