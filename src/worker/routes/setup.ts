import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from '../../shared/ulid';
import { hashPassword, timingSafeEqual } from '../lib/crypto';
import { rowToUser, type UserRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import { isStrongSecret } from '../lib/sign';
import { jsonBody, zEmail, zName, zPassword } from '../lib/validate';
import { createSession } from '../middleware/session';
import type { AppEnv } from '../types';

export const setup = new Hono<AppEnv>();

async function userCount(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM users').first<number>('n')) ?? 0;
}

setup.get('/status', async (c) => c.json({ needsSetup: (await userCount(c.env.DB)) === 0 }));

const SetupSchema = z.object({ token: z.string().min(1).max(500), name: zName, email: zEmail, password: zPassword });

setup.post('/', async (c) => {
  const body = await jsonBody(c, SetupSchema);
  const expected = c.env.SETUP_TOKEN;
  // A placeholder or short token is guessable: refuse it before comparing anything.
  if (!isStrongSecret(expected)) {
    throw new HttpError(503, 'SETUP_NOT_CONFIGURED', 'SETUP_TOKEN is missing, shorter than 24 characters or a placeholder. Set it to a long random value (openssl rand -hex 32).');
  }
  if (!timingSafeEqual(body.token, expected)) throw new HttpError(403, 'INVALID_TOKEN', 'Setup token does not match');
  if ((await userCount(c.env.DB)) > 0) throw new HttpError(409, 'ALREADY_SETUP', 'Setup has already been completed');
  const now = Date.now();
  const id = ulid(now);
  // INSERT ... WHERE NOT EXISTS closes the race between two concurrent setup requests.
  const res = await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'admin', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  ).bind(id, body.email, body.name, await hashPassword(body.password), now, now).run();
  if (!res.meta.changes) throw new HttpError(409, 'ALREADY_SETUP', 'Setup has already been completed');
  await createSession(c, id);
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  return c.json({ user: rowToUser(user!) });
});
