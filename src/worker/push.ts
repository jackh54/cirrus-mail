// Web Push delivery: zero-config VAPID keys in `settings`, per-subscription sends with cleanup, and the new-mail trigger.
import type { Address, PushPayload, PushTestResponse } from '../shared/api';
import { hit } from './lib/ratelimit';
import { cleanHeaderText } from './lib/validate';
import { encryptPayload, importVapidPrivateKey, isAllowedPushEndpoint, vapidAuthorization, generateVapidKeys, type VapidKeys } from './lib/webpush';

export const PUSH_TTL_SECONDS = 86_400;
export const PUSH_MAX_FAILURES = 5;
export const PUSH_MAX_PAYLOAD_BYTES = 3 * 1024;
export const PUSH_THREAD_WINDOW_MS = 10_000;
export const PUSH_HOURLY_CAP = 60;

export interface PushSubscriptionRow {
  id: string; user_id: string; endpoint: string; p256dh: string; auth: string;
}

export interface Vapid { keys: VapidKeys; subject: string }

const SETTINGS_SQL = "SELECT key, value FROM settings WHERE key IN ('vapid_public', 'vapid_private_jwk', 'vapid_origin')";
const FIRST_ADMIN_SQL = "SELECT email FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1";

async function readVapidRows(db: D1Database): Promise<{ settings: Map<string, string>; adminEmail: string | null }> {
  const [settings, admin] = await db.batch([db.prepare(SETTINGS_SQL), db.prepare(FIRST_ADMIN_SQL)]);
  const map = new Map((settings.results as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  return { settings: map, adminEmail: (admin.results[0] as { email: string } | undefined)?.email ?? null };
}

/**
 * The instance's VAPID keys, generated on first use. Concurrent first uses race safely: each inserts its own
 * pair with ON CONFLICT DO NOTHING in one atomic batch, so exactly one pair wins, and everyone reads that back.
 * `origin` (`https://<request host>`) is stored once as the fallback VAPID subject for sends outside a request.
 */
export async function getVapid(db: D1Database, origin?: string): Promise<Vapid> {
  let { settings, adminEmail } = await readVapidRows(db);
  const missingKeys = !settings.get('vapid_public') || !settings.get('vapid_private_jwk');
  const missingOrigin = !!origin && !settings.get('vapid_origin');
  if (missingKeys || missingOrigin) {
    const stmts: D1PreparedStatement[] = [];
    if (missingKeys) {
      const gen = await generateVapidKeys();
      const insert = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING';
      stmts.push(db.prepare(insert).bind('vapid_public', gen.publicKey), db.prepare(insert).bind('vapid_private_jwk', JSON.stringify(gen.privateJwk)));
    }
    if (missingOrigin) stmts.push(db.prepare("INSERT INTO settings (key, value) VALUES ('vapid_origin', ?) ON CONFLICT(key) DO NOTHING").bind(origin));
    await db.batch(stmts);
    ({ settings, adminEmail } = await readVapidRows(db));
  }
  const publicKey = settings.get('vapid_public');
  const jwk = settings.get('vapid_private_jwk');
  if (!publicKey || !jwk) throw new Error('vapid keys unavailable');
  const privateKey = await importVapidPrivateKey(JSON.parse(jwk) as JsonWebKey);
  const subject = adminEmail ? `mailto:${adminEmail}` : settings.get('vapid_origin') ?? 'mailto:postmaster@localhost';
  return { keys: { publicKey, privateKey }, subject };
}

/** `https://<host>` of a request URL, the VAPID subject fallback. */
export function originForSubject(requestUrl: string): string {
  return `https://${new URL(requestUrl).host}`;
}

type SendResult = 'ok' | 'gone' | 'failed';

/** Encrypts and POSTs one message. Never throws; only status codes are logged. */
async function sendOne(sub: PushSubscriptionRow, payload: PushPayload, vapid: Vapid, now: number): Promise<SendResult> {
  try {
    // Re-checked at send time, so a row from before the allowlist (or a hand-edited one) is never fetched.
    if (!isAllowedPushEndpoint(sub.endpoint)) return 'gone';
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    if (plaintext.byteLength > PUSH_MAX_PAYLOAD_BYTES) throw new Error('payload too large');
    const body = await encryptPayload(plaintext, sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: await vapidAuthorization(sub.endpoint, vapid.subject, vapid.keys, now),
        ttl: String(PUSH_TTL_SECONDS),
        urgency: 'normal',
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
      },
      body,
    });
    await res.body?.cancel();
    if (res.status >= 200 && res.status < 300) return 'ok';
    if (res.status === 404 || res.status === 410) return 'gone';
    console.error('push send failed', res.status);
    return 'failed';
  } catch (e) {
    console.error('push send error', (e as Error).name);
    return 'failed';
  }
}

/**
 * Sends each item and records the outcome in one batch: success resets `failures`, 404/410 deletes the
 * subscription, anything else counts a failure and deletes the subscription at PUSH_MAX_FAILURES.
 */
export async function deliver(db: D1Database, items: { sub: PushSubscriptionRow; payload: PushPayload }[], vapid: Vapid, now = Date.now()): Promise<PushTestResponse> {
  const results = await Promise.all(items.map((i) => sendOne(i.sub, i.payload, vapid, now)));
  const stmts: D1PreparedStatement[] = [];
  let sent = 0;
  items.forEach(({ sub }, i) => {
    const r = results[i];
    if (r === 'ok') {
      sent++;
      stmts.push(db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?').bind(now, sub.id));
    } else if (r === 'gone') {
      stmts.push(db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id));
    } else {
      stmts.push(
        db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').bind(sub.id),
        db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND failures >= ?').bind(sub.id, PUSH_MAX_FAILURES),
      );
    }
  });
  if (stmts.length) await db.batch(stmts);
  return { sent, failed: items.length - sent };
}

/** Cuts to `max` code points with control characters removed. */
function clip(s: string, max: number): string {
  const chars = Array.from(cleanHeaderText(s).trim());
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

export interface NewMail {
  mailboxId: string;
  mailboxAddress: string;
  threadId: string;
  from: Address;
  subject: string;
}

export function mailPayload(m: NewMail, preview: boolean): PushPayload {
  return preview
    ? { type: 'mail', mailboxId: m.mailboxId, threadId: m.threadId, title: clip(m.from.name || m.from.email, 120) || 'New mail', body: clip(m.subject, 240) || '(no subject)', tag: m.threadId }
    : { type: 'mail', mailboxId: m.mailboxId, threadId: m.threadId, title: 'New mail', body: clip(m.mailboxAddress, 240), tag: m.threadId };
}

/** Per user: at most one push per thread per 10 s, and at most PUSH_HOURLY_CAP per hour. */
async function allowPush(db: D1Database, userId: string, threadId: string, now: number): Promise<boolean> {
  if ((await hit(db, `push:t:${userId}:${threadId}`, PUSH_THREAD_WINDOW_MS, now)) > 1) return false;
  return (await hit(db, `push:h:${userId}`, 3600_000, now)) <= PUSH_HOURLY_CAP;
}

/**
 * Pushes a new Inbox message to every device of every active member of the mailbox. Runs in waitUntil after
 * the message is stored: it never throws, and only error names and status codes are logged, never content.
 */
export async function notifyNewMail(env: Env, m: NewMail, now = Date.now()): Promise<void> {
  try {
    const db = env.DB;
    const { results } = await db.prepare(
      `SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth, u.push_preview
         FROM push_subscriptions ps
         JOIN mailbox_members mm ON mm.user_id = ps.user_id AND mm.mailbox_id = ?
         JOIN users u ON u.id = ps.user_id
        WHERE u.disabled = 0`,
    ).bind(m.mailboxId).all<PushSubscriptionRow & { push_preview: number }>();
    if (!results.length) return;
    const users = [...new Set(results.map((r) => r.user_id))];
    const allowed = new Set((await Promise.all(users.map(async (u) => ((await allowPush(db, u, m.threadId, now)) ? u : null)))).filter((u) => u !== null));
    const items = results.filter((r) => allowed.has(r.user_id)).map((r) => ({ sub: r, payload: mailPayload(m, r.push_preview !== 0) }));
    if (!items.length) return;
    await deliver(db, items, await getVapid(db), now);
  } catch (e) {
    console.error('push notify error', (e as Error).name);
  }
}
