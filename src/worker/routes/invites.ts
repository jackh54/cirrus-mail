import { Hono } from 'hono';
import { z } from 'zod';
import type { InviteLookupResponse } from '../../shared/api';
import { hashPassword, sha256Hex } from '../lib/crypto';
import { rowToUser, type UserRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import { hit } from '../lib/ratelimit';
import { jsonBody, zName, zPassword } from '../lib/validate';
import { createSession } from '../middleware/session';
import type { AppEnv } from '../types';
import { memberAddresses } from '../invite-email';

export const invites = new Hono<AppEnv>();

const INVITE_WINDOW_MS = 15 * 60 * 1000;
const INVITE_MAX_PER_IP = 20;

const TokenSchema = z.string().min(1).max(200);

// One answer for unknown, expired and disabled-user tokens, so a probe learns nothing.
const invalid = () => new HttpError(404, 'INVITE_INVALID', 'This invite link is invalid or has expired');

async function limit(c: { env: Env; req: { header(n: string): string | undefined } }) {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if ((await hit(c.env.DB, `invite:${ip}`, INVITE_WINDOW_MS)) > INVITE_MAX_PER_IP) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again in 15 minutes.');
  }
}

invites.post('/lookup', async (c) => {
  await limit(c);
  const { token } = await jsonBody(c, z.object({ token: TokenSchema }));
  const db = c.env.DB;
  const row = await db.prepare(
    `SELECT i.user_id, i.expires_at, u.email, u.name, inv.name AS inviter_name
       FROM invites i JOIN users u ON u.id = i.user_id LEFT JOIN users inv ON inv.id = i.created_by
      WHERE i.token_hash = ? AND i.expires_at > ? AND u.disabled = 0`,
  ).bind(await sha256Hex(token), Date.now()).first<{ user_id: string; expires_at: number; email: string; name: string; inviter_name: string | null }>();
  if (!row) throw invalid();
  const mailboxAddresses = await memberAddresses(db, row.user_id);
  const out: InviteLookupResponse = { email: row.email, name: row.name, inviterName: row.inviter_name, mailboxAddresses, expiresAt: row.expires_at };
  return c.json(out);
});

invites.post('/accept', async (c) => {
  await limit(c);
  const b = await jsonBody(c, z.object({ token: TokenSchema, name: zName, password: zPassword }));
  const db = c.env.DB;
  const now = Date.now();
  const hash = await sha256Hex(b.token);
  const passwordHash = await hashPassword(b.password);
  // One transaction: set the password, end old sessions and consume the invite, or do nothing. Single use,
  // not expired, and a disabled user's invite is left alone. The DELETE runs last and reports who it was.
  const claim = "(SELECT i.user_id FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?1 AND i.expires_at > ?2 AND u.disabled = 0)";
  const [, , consumed] = await db.batch([
    db.prepare(`UPDATE users SET password_hash = ?3, name = ?4, must_change_password = 0, updated_at = ?2 WHERE id = ${claim}`).bind(hash, now, passwordHash, b.name),
    db.prepare(`DELETE FROM sessions WHERE user_id = ${claim}`).bind(hash, now),
    db.prepare(`DELETE FROM invites WHERE user_id = ${claim} RETURNING user_id`).bind(hash, now),
  ]);
  const userId = (consumed.results[0] as { user_id?: string } | undefined)?.user_id;
  if (!userId) throw invalid();
  await createSession(c, userId);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<UserRow>();
  return c.json({ user: rowToUser(user!) });
});
