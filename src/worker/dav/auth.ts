// HTTP Basic authentication for /dav: login email + an app password. The account password and the
// session cookie are never accepted here.
import { sha256Hex } from '../lib/crypto';
import type { UserRow } from '../lib/db';
import { hit } from '../lib/ratelimit';

export const FAIL_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILS_PER_IP = 30;
export const MAX_FAILS_PER_USER = 10;
const LAST_USED_EVERY_MS = 60 * 60 * 1000;

/** App passwords are shown in groups; accept any case and ignore separators. */
export function normalizeAppPassword(s: string): string {
  return s.toLowerCase().replace(/[\s-]/g, '');
}

export function challenge(status: 401 | 429 = 401): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (status === 401) headers['www-authenticate'] = 'Basic realm="Cirrus Mail", charset="UTF-8"';
  else headers['retry-after'] = String(FAIL_WINDOW_MS / 1000);
  return new Response(status === 401 ? 'Authentication required' : 'Too many failed attempts', { status, headers });
}

function parseBasic(header: string | null): { user: string; pass: string } | null {
  if (!header || header.length > 1024 || !/^basic\s/i.test(header)) return null;
  try {
    const bin = atob(header.slice(6).trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const i = s.indexOf(':');
    return i < 0 ? null : { user: s.slice(0, i), pass: s.slice(i + 1) };
  } catch {
    return null;
  }
}

async function overLimit(db: D1Database, keys: [string, number][], now: number): Promise<boolean> {
  const { results } = await db.prepare(`SELECT key, count FROM rate_limits WHERE key IN (${keys.map(() => '?').join(',')}) AND window_end >= ?`)
    .bind(...keys.map(([k]) => k), now).all<{ key: string; count: number }>();
  return results.some((r) => r.count >= (keys.find(([k]) => k === r.key)?.[1] ?? Infinity));
}

/** The authenticated user, or the 401 / 429 response to send. Only failed attempts are counted. */
export async function authenticate(request: Request, env: Env): Promise<UserRow | Response> {
  const cred = parseBasic(request.headers.get('authorization'));
  if (!cred) return challenge();
  const db = env.DB;
  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const username = cred.user.trim().toLowerCase().slice(0, 254);
  const ipKey = `davfail:ip:${ip}`;
  const userKey = `davfail:user:${username}`;
  if (await overLimit(db, [[ipKey, MAX_FAILS_PER_IP], [userKey, MAX_FAILS_PER_USER]], now)) return challenge(429);

  const hash = await sha256Hex(normalizeAppPassword(cred.pass));
  const row = await db.prepare(
    `SELECT ap.id AS ap_id, ap.last_used_at AS ap_used, u.* FROM app_passwords ap JOIN users u ON u.id = ap.user_id
      WHERE ap.token_hash = ? AND lower(u.email) = ? AND u.disabled = 0`,
  ).bind(hash, username).first<UserRow & { ap_id: string; ap_used: number | null }>();
  if (!row) {
    await Promise.all([hit(db, ipKey, FAIL_WINDOW_MS, now), hit(db, userKey, FAIL_WINDOW_MS, now)]);
    return challenge();
  }
  const { ap_id, ap_used, ...user } = row;
  if (ap_used === null || now - ap_used > LAST_USED_EVERY_MS) {
    await db.prepare('UPDATE app_passwords SET last_used_at = ? WHERE id = ?').bind(now, ap_id).run();
  }
  return user as UserRow;
}
