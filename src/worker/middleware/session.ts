import type { Context, MiddlewareHandler } from 'hono';
import type { FolderRole } from '../../shared/api';
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

type AuthRow = UserRow & {
  session_id: string; session_seen: number; session_expires: number;
  mb_id?: string | null; mb_address?: string; mb_display_name?: string; mb_role?: 'owner' | 'member'; mb_roles?: string;
};

const SESSION_SQL = `SELECT s.id AS session_id, s.last_seen_at AS session_seen, s.expires_at AS session_expires, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1`;

// The same lookup plus the caller's membership of mailbox ?2 and that mailbox's system folder ids.
// The mailbox columns are NULL unless the session user is a member (the authz join on mailbox_members).
const SESSION_MAILBOX_SQL = `SELECT s.id AS session_id, s.last_seen_at AS session_seen, s.expires_at AS session_expires, u.*,
         m.id AS mb_id, m.address AS mb_address, m.display_name AS mb_display_name, mm.role AS mb_role,
         (SELECT json_group_object(f.role, f.id) FROM folders f WHERE f.mailbox_id = m.id AND f.role IS NOT NULL) AS mb_roles
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN mailbox_members mm ON mm.mailbox_id = ?2 AND mm.user_id = u.id
       LEFT JOIN mailboxes m ON m.id = mm.mailbox_id
      WHERE s.token_hash = ?1`;

/** The session user's id, for read statements that ride in the same batch as the session lookup. Binds the token hash. */
export const SESSION_USER_SQL = '(SELECT user_id FROM sessions WHERE token_hash = ?)';

/**
 * Validates the session (and, when `mb` is given, membership of that mailbox) in one D1 round trip,
 * together with `reads`. The results of `reads` are only returned once access is confirmed, so they may
 * be built before it is (they must be read-only). Sliding expiry is touched at most every 5 minutes.
 */
async function authorize(c: Context<AppEnv>, mb: string | null, reads: (tokenHash: string) => D1PreparedStatement[]): Promise<D1Result[]> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  const now = Date.now();
  const db = c.env.DB;
  const hash = await sha256Hex(token);
  const lookup = mb === null ? db.prepare(SESSION_SQL).bind(hash) : db.prepare(SESSION_MAILBOX_SQL).bind(hash, mb);
  const extra = reads(hash);
  const [auth, ...rest] = extra.length ? await db.batch([lookup, ...extra]) : [await lookup.all()];
  const row = auth.results[0] as AuthRow | undefined;
  if (!row || row.session_expires < now || row.disabled) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired');
  }
  if (now - row.session_seen > TOUCH_INTERVAL_MS) {
    // Off the critical path: the response does not wait for this write.
    c.executionCtx.waitUntil(db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').bind(now, now + SESSION_TTL_MS, row.session_id).run());
    writeCookie(c, token);
  }
  const {
    session_id, session_seen: _s, session_expires: _e,
    mb_id, mb_address, mb_display_name, mb_role, mb_roles, ...user
  } = row;
  c.set('user', user as UserRow);
  c.set('sessionId', session_id);
  if (mb !== null) {
    if (!mb_id) throw new HttpError(404, 'NOT_FOUND', 'Mailbox not found');
    c.set('mailbox', {
      id: mb_id, address: mb_address!, displayName: mb_display_name!, role: mb_role!,
      roles: JSON.parse(mb_roles ?? '{}') as Record<FolderRole, string>,
    });
  }
  return rest;
}

/** Session check for handlers that run their first reads in the same round trip. `reads` gets the token hash. */
export const authorizeSession = (c: Context<AppEnv>, reads: (tokenHash: string) => D1PreparedStatement[]) => authorize(c, null, reads);

/** Session + mailbox membership check for handlers that run their first reads in the same round trip. `reads` gets the requested mailbox id. */
export function authorizeMailbox(c: Context<AppEnv>, reads: (mb: string) => D1PreparedStatement[]): Promise<D1Result[]> {
  const mb = c.req.param('mb') ?? '';
  return authorize(c, mb, () => reads(mb));
}

/** Requires a valid session. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  await authorize(c, null, () => []);
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

/** Requires a valid session and resolves `:mb` to a mailbox the user is a member of; 404 otherwise (no existence oracle). */
export const requireMailbox: MiddlewareHandler<AppEnv> = async (c, next) => {
  await authorize(c, c.req.param('mb') ?? '', () => []);
  await next();
};
