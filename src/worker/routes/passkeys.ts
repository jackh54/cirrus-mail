import { Hono } from 'hono';
import { z } from 'zod';
import type { PasskeyInfo } from '../../shared/api';
import { HttpError } from '../lib/errors';
import { finishRegistration, PasskeyAttestationSchema, registrationOptions, relyingParty, type PasskeyRow } from '../lib/passkeys';
import { jsonBody, zHeaderText } from '../lib/validate';
import { requireAuth } from '../middleware/session';
import type { AppEnv } from '../types';
import { requireCurrentPassword } from './me';

// Passkey management for the signed-in user. Adding and removing need the current password (rate-limited like
// the other security changes); the password is checked before a registration challenge is issued.
export const passkeys = new Hono<AppEnv>();
passkeys.use('*', requireAuth);

const toInfo = (r: Pick<PasskeyRow, 'id' | 'name' | 'created_at' | 'last_used_at'>): PasskeyInfo => ({
  id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

passkeys.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at')
    .bind(c.get('user').id).all<PasskeyRow>();
  return c.json(results.map(toInfo));
});

passkeys.post('/options', async (c) => {
  const body = await jsonBody(c, z.object({ password: z.string().min(1).max(256) }));
  const u = c.get('user');
  await requireCurrentPassword(c.env.DB, u, body.password, 'Password is incorrect');
  const options = await registrationOptions(c.env.DB, u, relyingParty(c.req.url), c.env.APP_NAME || 'Cirrus Mail', Date.now());
  return c.json({ options });
});

passkeys.post('/', async (c) => {
  const body = await jsonBody(c, z.object({ credential: PasskeyAttestationSchema, name: zHeaderText(60).optional() }));
  const row = await finishRegistration(c.env.DB, c.get('user'), body.credential, body.name || 'Passkey', relyingParty(c.req.url), Date.now());
  return c.json(toInfo(row), 201);
});

passkeys.patch('/:id', async (c) => {
  const body = await jsonBody(c, z.object({ name: zHeaderText(60, 1) }));
  const res = await c.env.DB.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').bind(body.name, c.req.param('id'), c.get('user').id).run();
  if (!res.meta.changes) throw new HttpError(404, 'NOT_FOUND', 'Passkey not found');
  return c.json({ ok: true });
});

passkeys.delete('/:id', async (c) => {
  const body = await jsonBody(c, z.object({ password: z.string().min(1).max(256) }));
  const u = c.get('user');
  await requireCurrentPassword(c.env.DB, u, body.password, 'Password is incorrect');
  const res = await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(c.req.param('id'), u.id).run();
  if (!res.meta.changes) throw new HttpError(404, 'NOT_FOUND', 'Passkey not found');
  return c.json({ ok: true });
});
