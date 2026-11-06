import { Hono } from 'hono';
import type { Contact } from '../../shared/api';
import { requireAuth } from '../middleware/session';
import { likeEscape } from '../search';
import type { AppEnv } from '../types';

export const contacts = new Hono<AppEnv>();
contacts.use('*', requireAuth);

contacts.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const uid = c.get('user').id;
  const stmt = q
    ? c.env.DB.prepare(
        `SELECT email, name FROM contacts WHERE user_id = ? AND (lower(email) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
          ORDER BY times_used DESC, last_used_at DESC LIMIT 8`,
      ).bind(uid, likeEscape(q), likeEscape(q))
    : c.env.DB.prepare('SELECT email, name FROM contacts WHERE user_id = ? ORDER BY times_used DESC, last_used_at DESC LIMIT 8').bind(uid);
  const { results } = await stmt.all<Contact>();
  return c.json(results);
});
