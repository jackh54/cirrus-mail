// JMAP authentication: HTTP Basic (login email + app password, exactly as /dav) or `Bearer <app password>`.
// The session cookie and the account password are never read here, so there is no CSRF exposure.
import { authenticate, challenge, FAIL_WINDOW_MS, LAST_USED_EVERY_MS, MAX_FAILS_PER_IP, normalizeAppPassword, overLimit } from '../dav/auth';
import { sha256Hex } from '../lib/crypto';
import type { UserRow } from '../lib/db';
import { hit } from '../lib/ratelimit';

/** The authenticated user, or the 401 / 429 response to send. Failed attempts share the DAV counters. */
export async function authenticateJmap(request: Request, env: Env): Promise<UserRow | Response> {
  const header = request.headers.get('authorization');
  if (!header || header.length > 1024 || !/^bearer\s/i.test(header)) return authenticate(request, env);
  const db = env.DB;
  const now = Date.now();
  const ipKey = `davfail:ip:${request.headers.get('cf-connecting-ip') ?? 'local'}`;
  if (await overLimit(db, [[ipKey, MAX_FAILS_PER_IP]], now)) return challenge(429);
  const hash = await sha256Hex(normalizeAppPassword(header.slice(7).trim()));
  const row = await db.prepare(
    `SELECT ap.id AS ap_id, ap.last_used_at AS ap_used, u.* FROM app_passwords ap JOIN users u ON u.id = ap.user_id
      WHERE ap.token_hash = ? AND u.disabled = 0`,
  ).bind(hash).first<UserRow & { ap_id: string; ap_used: number | null }>();
  if (!row) {
    await hit(db, ipKey, FAIL_WINDOW_MS, now);
    return challenge();
  }
  const { ap_id, ap_used, ...user } = row;
  if (ap_used === null || now - ap_used > LAST_USED_EVERY_MS) {
    await db.prepare('UPDATE app_passwords SET last_used_at = ? WHERE id = ?').bind(now, ap_id).run();
  }
  return user as UserRow;
}
