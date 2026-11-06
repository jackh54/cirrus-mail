import { Hono } from 'hono';
import { z } from 'zod';
import type { BlockedSender } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { HttpError, notFound } from '../lib/errors';
import { jsonBody } from '../lib/validate';
import type { AppEnv } from '../types';

export const blocked = new Hono<AppEnv>();

// A full address or "@domain".
const Pattern = z.string().trim().toLowerCase().min(3).max(254).regex(/^([^\s@<>]+)?@[^\s@<>]+\.[^\s@<>]+$/, 'Use a full address or @domain');

blocked.get('/blocked', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, pattern, created_at AS createdAt FROM blocked_senders WHERE mailbox_id = ? ORDER BY pattern').bind(c.get('mailbox').id).all<BlockedSender>();
  return c.json(results);
});

blocked.post('/blocked', async (c) => {
  const b = await jsonBody(c, z.object({ pattern: Pattern }));
  const mb = c.get('mailbox').id;
  const now = Date.now();
  const id = ulid(now);
  const res = await c.env.DB.prepare('INSERT INTO blocked_senders (id, mailbox_id, pattern, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(mailbox_id, pattern) DO NOTHING')
    .bind(id, mb, b.pattern, now).run();
  if (!res.meta.changes) throw new HttpError(409, 'ALREADY_BLOCKED', 'That sender is already blocked');
  const item: BlockedSender = { id, pattern: b.pattern, createdAt: now };
  return c.json(item, 201);
});

blocked.delete('/blocked/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM blocked_senders WHERE id = ? AND mailbox_id = ?').bind(c.req.param('id'), c.get('mailbox').id).run();
  if (!res.meta.changes) throw notFound('Blocked sender not found');
  return c.json({ ok: true });
});
