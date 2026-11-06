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
  // Address-book (CardDAV) emails fill the remaining slots, without repeating an address already suggested.
  if (results.length < 8) {
    const like = likeEscape(q);
    const { results: cards } = await c.env.DB.prepare(
      `SELECT o.fn, o.emails FROM dav_objects o JOIN dav_collections col ON col.id = o.collection_id
        WHERE col.user_id = ? AND col.kind = 'addressbook' AND o.emails != ''
          AND (? = '' OR lower(o.fn) LIKE ? ESCAPE '\\' OR o.emails LIKE ? ESCAPE '\\') ORDER BY o.fn COLLATE NOCASE LIMIT 20`,
    ).bind(uid, q, like, like).all<{ fn: string; emails: string }>();
    const seen = new Set(results.map((r) => r.email.toLowerCase()));
    const needle = q.toLowerCase();
    for (const card of cards) {
      for (const email of card.emails.split('\n')) {
        if (results.length >= 8) break;
        if (seen.has(email) || (needle && !email.includes(needle) && !card.fn.toLowerCase().includes(needle))) continue;
        seen.add(email);
        results.push({ email, name: card.fn === email ? '' : card.fn });
      }
    }
  }
  return c.json(results);
});
