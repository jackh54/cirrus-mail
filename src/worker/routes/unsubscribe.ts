import { Hono } from 'hono';
import { z } from 'zod';
import type { UnsubscribeResponse } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { HttpError, notFound } from '../lib/errors';
import { hit } from '../lib/ratelimit';
import { recordSendsSafe } from '../lib/sendcount';
import { postOneClick, readStoredUnsub, unsubscribeInfo } from '../lib/unsubscribe';
import { cleanHeaderText, jsonBody } from '../lib/validate';
import type { AppEnv } from '../types';

export const unsubscribe = new Hono<AppEnv>();

export const UNSUBSCRIBE_PER_HOUR = 30;

/**
 * Unsubscribes from the list a message came from. The client sends only the message id: the URL or address
 * comes from the header stored when the message arrived (and only if it passed aligned authentication).
 */
unsubscribe.post('/messages/:id/unsubscribe', async (c) => {
  const b = await jsonBody(c, z.object({ blockSender: z.boolean().optional() }));
  const { id: mb, address, displayName } = c.get('mailbox');
  const db = c.env.DB;
  const row = await db.prepare("SELECT from_email, unsub_json FROM messages WHERE id = ? AND mailbox_id = ? AND direction = 'in'")
    .bind(c.req.param('id'), mb).first<{ from_email: string; unsub_json: string | null }>();
  const info = unsubscribeInfo(row?.unsub_json ?? null);
  if (!row || !info) throw notFound('This message has no unsubscribe option');
  const stored = readStoredUnsub(row.unsub_json)!;

  if ((await hit(db, `unsub:${c.get('user').id}`, 3600_000)) > UNSUBSCRIBE_PER_HOUR) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many unsubscribe requests. Try again later.');
  }

  let ok = true;
  if (info.method === 'one_click') {
    ok = await postOneClick(stored.url!);
  } else if (info.method === 'mailto') {
    const now = Date.now();
    let code: string | null = null;
    try {
      const name = cleanHeaderText(displayName).trim();
      await c.env.EMAIL.send({
        from: name ? { email: address, name } : address,
        to: stored.mailto!,
        subject: cleanHeaderText(stored.subject || 'unsubscribe').trim() || 'unsubscribe',
        text: 'unsubscribe',
      });
      await recordSendsSafe(db, 1, now);
    } catch (e) {
      ok = false;
      const raw = (e as { code?: unknown }).code;
      code = typeof raw === 'string' && /^E_[A-Z_]{1,48}$/.test(raw) ? raw : 'E_DELIVERY_FAILED';
      console.error('unsubscribe mail failed', code);
    }
    await db.prepare('INSERT INTO send_log (id, mailbox_id, message_id, recipients, ok, error_code, created_at) VALUES (?, ?, NULL, 1, ?, ?, ?)')
      .bind(ulid(now), mb, ok ? 1 : 0, code, now).run();
  }

  let blocked = false;
  if (b.blockSender && row.from_email) {
    await db.prepare('INSERT INTO blocked_senders (id, mailbox_id, pattern, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(mailbox_id, pattern) DO NOTHING')
      .bind(ulid(), mb, row.from_email.toLowerCase(), Date.now()).run();
    blocked = true;
  }
  const res: UnsubscribeResponse = { method: info.method, ok, blocked, url: info.method === 'link' ? info.url : null };
  return c.json(res);
});
