import { Hono } from 'hono';
import { z } from 'zod';
import type { PushDevice, PushPayload, PushPublicKeyResponse } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { fromBase64Url } from '../lib/crypto';
import { HttpError, notFound } from '../lib/errors';
import { hit } from '../lib/ratelimit';
import { jsonBody } from '../lib/validate';
import { isAllowedPushEndpoint } from '../lib/webpush';
import { requireAuth } from '../middleware/session';
import { deliver, getVapid, originForSubject, type PushSubscriptionRow } from '../push';
import type { AppEnv } from '../types';

export const push = new Hono<AppEnv>();

push.use('*', requireAuth);

/** Devices per user. Bounds the fan-out of every inbound message. */
export const MAX_PUSH_DEVICES = 20;

const zEndpoint = z.string().max(2048).refine(isAllowedPushEndpoint, 'Not a supported push service endpoint');

function b64urlBytes(len: number, check?: (b: Uint8Array) => boolean) {
  return z.string().max(200).regex(/^[A-Za-z0-9_-]+={0,2}$/).refine((s) => {
    try {
      const b = fromBase64Url(s.replace(/=+$/, ''));
      return b.byteLength === len && (!check || check(b));
    } catch {
      return false;
    }
  }, 'Invalid key').transform((s) => s.replace(/=+$/, ''));
}

const SubscriptionSchema = z.object({
  endpoint: zEndpoint,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: b64urlBytes(65, (b) => b[0] === 4), auth: b64urlBytes(16) }),
});

push.get('/public-key', async (c) => {
  const vapid = await getVapid(c.env.DB, originForSubject(c.req.url));
  const body: PushPublicKeyResponse = { publicKey: vapid.keys.publicKey };
  return c.json(body);
});

// Upserts by endpoint and binds the subscription to the caller (a browser that signs in as someone else moves over).
push.post('/subscriptions', async (c) => {
  const b = await jsonBody(c, SubscriptionSchema);
  const userId = c.get('user').id;
  const db = c.env.DB;
  const count = await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ? AND endpoint != ?').bind(userId, b.endpoint).first<number>('n');
  if ((count ?? 0) >= MAX_PUSH_DEVICES) {
    throw new HttpError(409, 'TOO_MANY_DEVICES', `At most ${MAX_PUSH_DEVICES} devices can receive notifications. Remove one first.`);
  }
  const now = Date.now();
  const ua = (c.req.header('user-agent') ?? '').slice(0, 300) || null;
  await db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, failures)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
       failures = 0,
       created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.created_at ELSE excluded.created_at END,
       last_success_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.last_success_at ELSE NULL END`,
  ).bind(ulid(now), userId, b.endpoint, b.keys.p256dh, b.keys.auth, ua, now).run();
  const row = await db.prepare('SELECT id, user_agent AS userAgent, created_at AS createdAt, last_success_at AS lastSuccessAt FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .bind(b.endpoint, userId).first<PushDevice>();
  return c.json(row, 201);
});

push.delete('/subscriptions', async (c) => {
  const b = await jsonBody(c, z.object({ endpoint: z.string().min(1).max(2048) }));
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(b.endpoint, c.get('user').id).run();
  return c.json({ ok: true });
});

push.get('/subscriptions', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, user_agent AS userAgent, created_at AS createdAt, last_success_at AS lastSuccessAt FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(c.get('user').id).all<PushDevice>();
  return c.json(results);
});

push.delete('/subscriptions/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).run();
  if (!res.meta.changes) throw notFound('Device not found');
  return c.json({ ok: true });
});

export const PUSH_TEST_PER_MINUTE = 5;

push.post('/test', async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  if ((await hit(db, `push:test:${user.id}`, 60_000)) > PUSH_TEST_PER_MINUTE) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many test notifications. Try again in a minute.');
  }
  const { results } = await db.prepare('SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .bind(user.id).all<PushSubscriptionRow>();
  if (!results.length) throw new HttpError(400, 'NO_DEVICES', 'Enable notifications on a device first');
  const payload: PushPayload = { type: 'test', title: 'Cirrus Mail', body: 'Test notification: push works on this device.', tag: 'cirrus-test' };
  const vapid = await getVapid(db, originForSubject(c.req.url));
  return c.json(await deliver(db, results.map((sub) => ({ sub, payload })), vapid));
});
