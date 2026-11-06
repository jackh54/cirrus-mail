import { Hono } from 'hono';
import { z } from 'zod';
import type { AppPassword, AppPasswordCreateResponse } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { normalizeAppPassword } from '../dav/auth';
import { base32Encode, randomBytes, sha256Hex } from '../lib/crypto';
import { HttpError, notFound } from '../lib/errors';
import { jsonBody, zHeaderText } from '../lib/validate';
import { requireAuth } from '../middleware/session';
import type { AppEnv } from '../types';
import { requireCurrentPassword } from './me';

export const appPasswords = new Hono<AppEnv>();
appPasswords.use('*', requireAuth);

const MAX_APP_PASSWORDS = 25;

interface Row { id: string; name: string; created_at: number; last_used_at: number | null }
const toApi = (r: Row): AppPassword => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at });

appPasswords.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, created_at, last_used_at FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC')
    .bind(c.get('user').id).all<Row>();
  return c.json(results.map(toApi));
});

appPasswords.post('/', async (c) => {
  const u = c.get('user');
  const body = await jsonBody(c, z.object({ name: zHeaderText(60, 1), password: z.string().min(1).max(256) }));
  await requireCurrentPassword(c.env.DB, u, body.password, 'Password is incorrect');
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?').bind(u.id).first<number>('n');
  if ((n ?? 0) >= MAX_APP_PASSWORDS) throw new HttpError(409, 'LIMIT_REACHED', 'Revoke an app password before creating another');
  // 120 random bits, shown once as six groups of four. Only the sha256 of the normalised secret is stored.
  const secret = base32Encode(randomBytes(15)).toLowerCase().match(/.{4}/g)!.join('-');
  const now = Date.now();
  const id = ulid(now);
  await c.env.DB.prepare('INSERT INTO app_passwords (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, u.id, body.name, await sha256Hex(normalizeAppPassword(secret)), now).run();
  const out: AppPasswordCreateResponse = { appPassword: { id, name: body.name, createdAt: now, lastUsedAt: null }, secret };
  return c.json(out, 201);
});

appPasswords.delete('/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('user').id).run();
  if (!r.meta.changes) throw notFound('No such app password');
  return c.json({ ok: true });
});
