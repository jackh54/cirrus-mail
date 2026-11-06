import { Hono } from 'hono';
import { z } from 'zod';
import type { Identity, MailboxSummary, SessionInfo } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { base32Encode, hashPassword, randomBytes, sha256Hex, verifyPassword, verifyTotpStep } from '../lib/crypto';
import { rowToUser, type UserRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import { clear, hit } from '../lib/ratelimit';
import { jsonBody, zName, zPassword } from '../lib/validate';
import { authorizeSession, requireAuth } from '../middleware/session';
import type { AppEnv } from '../types';
import { LOGIN_WINDOW_MS, normalizeRecoveryCode } from './auth';

export const me = new Hono<AppEnv>();

/** Mailboxes and send-as aliases of the user given by `user` (a `?` or a scalar subquery, with its params). */
function summaryStmts(db: D1Database, user: { sql: string; params: unknown[] }): D1PreparedStatement[] {
  return [
    db.prepare(
      `SELECT m.id, m.address, m.display_name, mm.role,
              (SELECT COUNT(*) FROM messages x
                WHERE x.mailbox_id = m.id AND x.folder_id = (SELECT id FROM folders WHERE mailbox_id = m.id AND role = 'inbox') AND x.is_read = 0) AS unread
         FROM mailboxes m JOIN mailbox_members mm ON mm.mailbox_id = m.id
        WHERE mm.user_id = ${user.sql} ORDER BY mm.role = 'member', m.address`,
    ).bind(...user.params),
    db.prepare(
      `SELECT a.address, a.mailbox_id FROM aliases a JOIN mailbox_members mm ON mm.mailbox_id = a.mailbox_id
        WHERE mm.user_id = ${user.sql} AND a.can_send = 1 ORDER BY a.address`,
    ).bind(...user.params),
  ];
}

export async function mailboxSummaries(db: D1Database, user: UserRow): Promise<MailboxSummary[]> {
  const [boxes, aliases] = await db.batch(summaryStmts(db, { sql: '?', params: [user.id] }));
  return toSummaries(boxes, aliases, user);
}

function toSummaries(boxes: D1Result, aliases: D1Result, user: UserRow): MailboxSummary[] {
  const aliasMap = new Map<string, string[]>();
  for (const a of aliases.results as { address: string; mailbox_id: string }[]) {
    aliasMap.set(a.mailbox_id, [...(aliasMap.get(a.mailbox_id) ?? []), a.address]);
  }
  return (boxes.results as { id: string; address: string; display_name: string; role: 'owner' | 'member'; unread: number }[]).map((b) => {
    const name = b.display_name || user.name;
    const identities: Identity[] = [
      { email: b.address, name, isAlias: false },
      ...(aliasMap.get(b.id) ?? []).map((email) => ({ email, name, isAlias: true })),
    ];
    return { id: b.id, address: b.address, displayName: b.display_name, role: b.role, unread: b.unread, identities };
  });
}

// Registered before the requireAuth guard and never calls next(): the session check and the mailbox reads
// share one D1 round trip. The reads find nothing unless the session is valid, and are only used once it is confirmed.
me.get('/', async (c) => {
  const [boxes, aliases] = await authorizeSession(c, (user) => summaryStmts(c.env.DB, user));
  const user = c.get('user');
  return c.json({ user: rowToUser(user), mailboxes: toSummaries(boxes, aliases, user) });
});

me.use('*', requireAuth);

export const REAUTH_MAX_FAILURES = 5;

/**
 * Checks the current password for a sensitive change. Like login, the attempt is counted atomically before
 * any hashing, per user, so a stolen session cannot brute-force the password (15-minute window).
 */
export async function requireCurrentPassword(db: D1Database, user: UserRow, password: string, message: string): Promise<void> {
  const key = `reauth:${user.id}`;
  if ((await hit(db, key, LOGIN_WINDOW_MS)) > REAUTH_MAX_FAILURES) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many password attempts. Try again in 15 minutes.');
  }
  if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(400, 'INVALID_PASSWORD', message);
  await clear(db, key);
}

const UpdateMeSchema = z.object({
  name: zName.optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  pushPreview: z.boolean().optional(),
  categoryTabs: z.boolean().optional(),
});

me.patch('/', async (c) => {
  const body = await jsonBody(c, UpdateMeSchema);
  const u = c.get('user');
  const pushPreview = body.pushPreview === undefined ? u.push_preview : body.pushPreview ? 1 : 0;
  const categoryTabs = body.categoryTabs === undefined ? u.category_tabs : body.categoryTabs ? 1 : 0;
  await c.env.DB.prepare('UPDATE users SET name = ?, theme = ?, density = ?, push_preview = ?, category_tabs = ?, updated_at = ? WHERE id = ?')
    .bind(body.name ?? u.name, body.theme ?? u.theme, body.density ?? u.density, pushPreview, categoryTabs, Date.now(), u.id).run();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.id).first<UserRow>();
  return c.json({ user: rowToUser(user!) });
});

me.post('/password', async (c) => {
  const body = await jsonBody(c, z.object({ current: z.string().min(1).max(256), next: zPassword }));
  const u = c.get('user');
  await requireCurrentPassword(c.env.DB, u, body.current, 'Current password is incorrect');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .bind(await hashPassword(body.next), Date.now(), u.id),
    // Changing the password signs out every other session.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(u.id, c.get('sessionId')),
  ]);
  return c.json({ ok: true });
});

me.post('/totp/begin', async (c) => {
  const u = c.get('user');
  if (u.totp_secret) throw new HttpError(409, 'TOTP_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
  const secret = base32Encode(randomBytes(20));
  await c.env.DB.prepare('UPDATE users SET totp_pending = ?, updated_at = ? WHERE id = ?').bind(secret, Date.now(), u.id).run();
  const issuer = c.env.APP_NAME || 'Cirrus Mail';
  const label = encodeURIComponent(`${issuer}:${u.email}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return c.json({ secret, otpauthUrl });
});

function recoveryCode(): string {
  const s = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5, 10)}`;
}

me.post('/totp/enable', async (c) => {
  const body = await jsonBody(c, z.object({ code: z.string().trim().min(6).max(10) }));
  const u = c.get('user');
  if (u.totp_secret) throw new HttpError(409, 'TOTP_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
  if (!u.totp_pending) throw new HttpError(400, 'TOTP_NOT_STARTED', 'Start enrolment first');
  const step = await verifyTotpStep(u.totp_pending, body.code);
  if (step === null) throw new HttpError(400, 'INVALID_CODE', 'That code is not valid');
  const codes = Array.from({ length: 10 }, recoveryCode);
  const now = Date.now();
  await c.env.DB.batch([
    // The enrolment code's step counts as used, so it cannot be replayed at the next login.
    c.env.DB.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ?, updated_at = ? WHERE id = ?').bind(step, now, u.id),
    c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(u.id),
    ...(await Promise.all(codes.map(async (code) =>
      c.env.DB.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)')
        .bind(ulid(now), u.id, await sha256Hex(normalizeRecoveryCode(code)))))),
  ]);
  return c.json({ recoveryCodes: codes });
});

me.post('/totp/disable', async (c) => {
  const body = await jsonBody(c, z.object({ password: z.string().min(1).max(256) }));
  const u = c.get('user');
  await requireCurrentPassword(c.env.DB, u, body.password, 'Password is incorrect');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0, updated_at = ? WHERE id = ?').bind(Date.now(), u.id),
    c.env.DB.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(u.id),
  ]);
  return c.json({ ok: true });
});

me.get('/sessions', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
  ).bind(c.get('user').id, Date.now()).all<{ id: string; user_agent: string | null; created_at: number; last_seen_at: number }>();
  const current = c.get('sessionId');
  const items: SessionInfo[] = results.map((s) => ({
    id: s.id, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === current,
  }));
  return c.json(items);
});

me.delete('/sessions/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).run();
  if (!res.meta.changes) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
  return c.json({ ok: true });
});
