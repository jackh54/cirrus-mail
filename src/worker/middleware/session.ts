import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ulid } from '../../shared/ulid';
import { randomBytes, sha256Hex, toBase64Url } from '../lib/crypto';
import type { UserRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../types';

export const SESSION_COOKIE = 'cirrus_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** `Secure` everywhere except plain-http localhost development. */
function isSecure(c: Context): boolean {
  const u = new URL(c.req.url);
  return !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'));
}

function writeCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: isSecure(c), sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const token = toBase64Url(randomBytes(32));
  const now = Date.now();
  const id = ulid(now);
  await c.env.DB.prepare('INSERT INTO sessions (id, token_hash, user_id, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, await sha256Hex(token), userId, (c.req.header('user-agent') ?? '').slice(0, 300) || null, now, now, now + SESSION_TTL_MS)
    .run();
  writeCookie(c, token);
  return id;
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isSecure(c), httpOnly: true, sameSite: 'Lax' });
}

/** Requires a valid session. Sliding expiry, touched at most every 5 minutes. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.id AS session_id, s.last_seen_at AS session_seen, s.expires_at AS session_expires, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(await sha256Hex(token)).first<UserRow & { session_id: string; session_seen: number; session_expires: number }>();
  if (!row || row.session_expires < now || row.disabled) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired');
  }
  if (now - row.session_seen > TOUCH_INTERVAL_MS) {
    await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').bind(now, now + SESSION_TTL_MS, row.session_id).run();
    writeCookie(c, token);
  }
  const { session_id, session_seen: _s, session_expires: _e, ...user } = row;
  c.set('user', user as UserRow);
  c.set('sessionId', session_id);
  await next();
};

/** Every state-changing /api request must carry `X-Cirrus: 1`. */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && c.req.header('x-cirrus') !== '1') {
    throw new HttpError(403, 'CSRF', 'Missing X-Cirrus header');
  }
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Admin only');
  await next();
};

/** Resolves `:mb` to a mailbox the session user is a member of; 404 otherwise (no existence oracle). */
export const mailboxAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const mb = c.req.param('mb');
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.address, m.display_name, mm.role FROM mailboxes m
       JOIN mailbox_members mm ON mm.mailbox_id = m.id WHERE m.id = ? AND mm.user_id = ?`,
  ).bind(mb ?? '', c.get('user').id).first<{ id: string; address: string; display_name: string; role: 'owner' | 'member' }>();
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Mailbox not found');
  c.set('mailbox', { id: row.id, address: row.address, displayName: row.display_name, role: row.role });
  await next();
};
