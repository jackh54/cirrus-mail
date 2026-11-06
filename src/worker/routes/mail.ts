import { Hono } from 'hono';
import { z } from 'zod';
import type { Folder, FolderRole, ThreadSummary } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import {
  attachmentToApi, decodeCursor, deleteMessagesForever, encodeCursor, folderIdsByRole, loadBody, loadMessageFull,
  loadSummaries, messageRowToFull, recomputeThreads, type AttachmentRow, type MessageRow, type ThreadRow,
} from '../lib/db';
import { HttpError, notFound } from '../lib/errors';
import { jsonBody, zId } from '../lib/validate';
import { buildSearchSql, parseSearch } from '../search';
import { parseJsonAddresses } from '../lib/addresses';
import type { AppEnv } from '../types';

export const mail = new Hono<AppEnv>();

const origin = (url: string) => new URL(url).origin;

// ---------- folders ----------

mail.get('/folders', async (c) => {
  const mb = c.get('mailbox').id;
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.name, f.role, f.sort, COALESCE(s.total, 0) AS total, COALESCE(s.unread, 0) AS unread
       FROM folders f
       LEFT JOIN (SELECT folder_id, COUNT(*) AS total, SUM(is_read = 0) AS unread FROM messages WHERE mailbox_id = ?1 GROUP BY folder_id) s
         ON s.folder_id = f.id
      WHERE f.mailbox_id = ?1 ORDER BY f.sort, f.name`,
  ).bind(mb).all<Folder>();
  return c.json(results);
});

const FolderName = z.string().trim().min(1).max(64);

mail.post('/folders', async (c) => {
  const body = await jsonBody(c, z.object({ name: FolderName, sort: z.number().int().min(0).max(10_000).optional() }));
  const mb = c.get('mailbox').id;
  const id = ulid();
  try {
    await c.env.DB.prepare('INSERT INTO folders (id, mailbox_id, name, role, sort, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .bind(id, mb, body.name, body.sort ?? 100, Date.now()).run();
  } catch {
    throw new HttpError(409, 'FOLDER_EXISTS', 'A folder with that name already exists');
  }
  const folder: Folder = { id, name: body.name, role: null, sort: body.sort ?? 100, unread: 0, total: 0 };
  return c.json(folder, 201);
});

async function customFolder(db: D1Database, mb: string, id: string) {
  const f = await db.prepare('SELECT id, name, role, sort FROM folders WHERE id = ? AND mailbox_id = ?').bind(id, mb).first<{ id: string; name: string; role: FolderRole | null; sort: number }>();
  if (!f) throw notFound('Folder not found');
  if (f.role) throw new HttpError(400, 'SYSTEM_FOLDER', 'System folders cannot be changed');
  return f;
}

mail.patch('/folders/:id', async (c) => {
  const body = await jsonBody(c, z.object({ name: FolderName.optional(), sort: z.number().int().min(0).max(10_000).optional() }));
  const mb = c.get('mailbox').id;
  const f = await customFolder(c.env.DB, mb, c.req.param('id'));
  try {
    await c.env.DB.prepare('UPDATE folders SET name = ?, sort = ? WHERE id = ?').bind(body.name ?? f.name, body.sort ?? f.sort, f.id).run();
  } catch {
    throw new HttpError(409, 'FOLDER_EXISTS', 'A folder with that name already exists');
  }
  const counts = await c.env.DB.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(is_read = 0), 0) AS unread FROM messages WHERE folder_id = ?').bind(f.id).first<{ total: number; unread: number }>();
  const folder: Folder = { id: f.id, name: body.name ?? f.name, role: null, sort: body.sort ?? f.sort, unread: counts?.unread ?? 0, total: counts?.total ?? 0 };
  return c.json(folder);
});

mail.delete('/folders/:id', async (c) => {
  const mb = c.get('mailbox').id;
  const f = await customFolder(c.env.DB, mb, c.req.param('id'));
  const roles = await folderIdsByRole(c.env.DB, mb);
  const now = Date.now();
  // Messages in a deleted folder are kept and moved to Archive.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE messages SET folder_id = ?, folder_changed_at = ?, updated_at = ? WHERE folder_id = ?').bind(roles.archive, now, now, f.id),
    c.env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(f.id),
  ]);
  return c.json({ ok: true });
});

// ---------- thread listing ----------

/**
 * Threads appear in a folder when any of their messages is in it. They are sorted by the date of the
 * latest message *in that folder* (so `lastMessageAt` in the list is that date), newest first.
 */
export async function listThreads(
  env: Env, mb: string, opts: { folder?: string; q?: string; cursor?: string; limit: number },
): Promise<{ items: ThreadSummary[]; nextCursor: string | null }> {
  const roles = await folderIdsByRole(env.DB, mb);
  const where: string[] = ['m.mailbox_id = ?'];
  const params: unknown[] = [mb];
  let isDrafts = false;
  if (opts.folder === 'starred') {
    where.push('m.is_starred = 1', 'm.folder_id NOT IN (?, ?)');
    params.push(roles.trash, roles.spam);
  } else if (opts.folder) {
    const f = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND mailbox_id = ?').bind(opts.folder, mb).first<string>('id');
    if (!f) throw notFound('Folder not found');
    where.push('m.folder_id = ?');
    params.push(f);
    isDrafts = f === roles.drafts;
  } else if (opts.q) {
    where.push('m.folder_id NOT IN (?, ?)');
    params.push(roles.trash, roles.spam);
  } else {
    where.push('m.folder_id = ?');
    params.push(roles.inbox);
  }
  if (opts.q) {
    const s = buildSearchSql(parseSearch(opts.q));
    where.push(...s.where);
    params.push(...s.params);
  }
  const cur = decodeCursor(opts.cursor);
  let having = '';
  if (cur) {
    having = 'HAVING k < ? OR (k = ? AND tid < ?)';
    params.push(cur.k, cur.k, cur.id);
  }
  params.push(opts.limit + 1);
  const { results } = await env.DB.prepare(
    `SELECT m.thread_id AS tid, MAX(m.date) AS k FROM messages m WHERE ${where.join(' AND ')}
      GROUP BY m.thread_id ${having} ORDER BY k DESC, tid DESC LIMIT ?`,
  ).bind(...params).all<{ tid: string; k: number }>();
  const page = results.slice(0, opts.limit);
  const keys = new Map(page.map((r) => [r.tid, r.k]));
  let items = await loadSummaries(env.DB, mb, page.map((r) => r.tid), keys);
  if (isDrafts && items.length) items = await overlayDrafts(env.DB, mb, roles.drafts, items);
  const last = page[page.length - 1];
  return { items, nextCursor: results.length > opts.limit && last ? encodeCursor(last.k, last.tid) : null };
}

/** In Drafts, a row shows the latest draft itself: its subject, snippet and recipients. */
async function overlayDrafts(db: D1Database, mb: string, draftsId: string, items: ThreadSummary[]): Promise<ThreadSummary[]> {
  const ph = items.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT thread_id, subject, snippet, to_json, date FROM messages
      WHERE mailbox_id = ? AND folder_id = ? AND thread_id IN (${ph}) ORDER BY date ASC`,
  ).bind(mb, draftsId, ...items.map((i) => i.id)).all<{ thread_id: string; subject: string; snippet: string; to_json: string }>();
  const latest = new Map(results.map((r) => [r.thread_id, r]));
  return items.map((t) => {
    const d = latest.get(t.id);
    return d ? { ...t, subject: d.subject, snippet: d.snippet, participants: parseJsonAddresses(d.to_json) } : t;
  });
}

mail.get('/threads', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const q = c.req.query('q')?.trim() || undefined;
  return c.json(await listThreads(c.env, c.get('mailbox').id, { folder: c.req.query('folder') || undefined, q, cursor: c.req.query('cursor'), limit }));
});

mail.get('/threads/:tid', async (c) => {
  const mb = c.get('mailbox').id;
  const tid = c.req.param('tid');
  const thread = await c.env.DB.prepare('SELECT * FROM threads WHERE id = ? AND mailbox_id = ?').bind(tid, mb).first<ThreadRow>();
  if (!thread) throw notFound('Thread not found');
  const [msgs, atts] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? AND mailbox_id = ? ORDER BY date ASC, id ASC').bind(tid, mb),
    c.env.DB.prepare('SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ? AND a.mailbox_id = ? ORDER BY a.created_at, a.id').bind(tid, mb),
  ]);
  const o = origin(c.req.url);
  const attByMsg = new Map<string, AttachmentRow[]>();
  for (const a of atts.results as unknown as AttachmentRow[]) attByMsg.set(a.message_id, [...(attByMsg.get(a.message_id) ?? []), a]);
  const messages = await Promise.all((msgs.results as unknown as MessageRow[]).map(async (m) => {
    const [body, list] = await Promise.all([loadBody(c.env, m.body_key), Promise.all((attByMsg.get(m.id) ?? []).map((a) => attachmentToApi(c.env, o, a)))]);
    return messageRowToFull(m, body, list);
  }));
  const [summary] = await loadSummaries(c.env.DB, mb, [tid]);
  return c.json({ thread: summary, messages });
});

// ---------- actions ----------

const ActionSchema = z.object({
  threadIds: z.array(zId).min(1).max(500),
  action: z.enum(['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'spam', 'not_spam', 'move', 'delete_forever']),
  folderId: zId.optional(),
});

mail.post('/threads/actions', async (c) => {
  const body = await jsonBody(c, ActionSchema);
  const mb = c.get('mailbox').id;
  const db = c.env.DB;
  const ids = [...new Set(body.threadIds)];
  const ph = ids.map(() => '?').join(',');
  const owned = (await db.prepare(`SELECT id FROM threads WHERE mailbox_id = ? AND id IN (${ph})`).bind(mb, ...ids).all<{ id: string }>()).results.map((r) => r.id);
  if (!owned.length) throw notFound('Thread not found');
  const tph = owned.map(() => '?').join(',');
  const roles = await folderIdsByRole(db, mb);
  const now = Date.now();
  const scope = `mailbox_id = ? AND thread_id IN (${tph})`;
  const move = (to: string, extra = '', extraParams: unknown[] = []) =>
    db.prepare(`UPDATE messages SET folder_id = ?, folder_changed_at = ?, updated_at = ? WHERE ${scope} AND folder_id != ? ${extra}`)
      .bind(to, now, now, mb, ...owned, to, ...extraParams);
  const NOT_OUTBOX = "AND status NOT IN ('draft','scheduled','sending')";
  switch (body.action) {
    case 'read':
    case 'unread':
      await db.prepare(`UPDATE messages SET is_read = ?, updated_at = ? WHERE ${scope}`).bind(body.action === 'read' ? 1 : 0, now, mb, ...owned).run();
      break;
    case 'star':
    case 'unstar':
      await db.prepare(`UPDATE messages SET is_starred = ?, updated_at = ? WHERE ${scope} ${NOT_OUTBOX}`).bind(body.action === 'star' ? 1 : 0, now, mb, ...owned).run();
      break;
    case 'archive':
      await move(roles.archive, 'AND folder_id = ?', [roles.inbox]).run();
      break;
    case 'trash':
      // Trashing cancels any scheduled send in the thread so the cron cannot deliver it from Trash.
      await db.batch([
        db.prepare(`UPDATE messages SET status = 'draft', send_at = NULL WHERE ${scope} AND status = 'scheduled'`).bind(mb, ...owned),
        move(roles.trash),
      ]);
      break;
    case 'spam':
      await move(roles.spam, "AND direction = 'in' AND folder_id != ?", [roles.trash]).run();
      break;
    case 'not_spam':
      await move(roles.inbox, 'AND folder_id = ?', [roles.spam]).run();
      break;
    case 'move': {
      if (!body.folderId) throw new HttpError(400, 'FOLDER_REQUIRED', 'folderId is required for move');
      const f = await db.prepare('SELECT id, role FROM folders WHERE id = ? AND mailbox_id = ?').bind(body.folderId, mb).first<{ id: string; role: FolderRole | null }>();
      if (!f) throw notFound('Folder not found');
      if (f.role === 'drafts' || f.role === 'scheduled') throw new HttpError(400, 'INVALID_FOLDER', 'Messages cannot be moved there');
      await move(f.id, NOT_OUTBOX).run();
      break;
    }
    case 'delete_forever': {
      const { results } = await db.prepare(`SELECT id FROM messages WHERE ${scope} AND folder_id IN (?, ?)`).bind(mb, ...owned, roles.trash, roles.spam).all<{ id: string }>();
      if (!results.length) throw new HttpError(400, 'NOT_IN_TRASH', 'Only messages in Trash or Spam can be deleted forever');
      await deleteMessagesForever(c.env, mb, results.map((r) => r.id));
      return c.json({ ok: true });
    }
  }
  await recomputeThreads(db, owned);
  return c.json({ ok: true });
});

// ---------- raw, poll, cancel-schedule ----------

mail.get('/messages/:id/raw', async (c) => {
  const row = await c.env.DB.prepare('SELECT raw_key, subject FROM messages WHERE id = ? AND mailbox_id = ?').bind(c.req.param('id'), c.get('mailbox').id).first<{ raw_key: string | null; subject: string }>();
  if (!row?.raw_key) throw notFound('Message not found');
  const obj = await c.env.BUCKET.get(row.raw_key);
  if (!obj) throw notFound('Message not found');
  return new Response(obj.body, {
    headers: {
      'content-type': 'message/rfc822',
      'content-disposition': `attachment; filename="message.eml"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});

mail.get('/poll', async (c) => {
  const mb = c.get('mailbox').id;
  const since = Number(c.req.query('since')) || 0;
  const roles = await folderIdsByRole(c.env.DB, mb);
  const [count, latest] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ? AND folder_id = ? AND is_read = 0 AND created_at > ?').bind(mb, roles.inbox, since),
    c.env.DB.prepare(`SELECT thread_id AS tid, MAX(date) AS k FROM messages WHERE mailbox_id = ? AND folder_id = ? AND created_at > ?
                       GROUP BY thread_id ORDER BY k DESC LIMIT 10`).bind(mb, roles.inbox, since),
  ]);
  const rows = latest.results as { tid: string; k: number }[];
  const items = await loadSummaries(c.env.DB, mb, rows.map((r) => r.tid), new Map(rows.map((r) => [r.tid, r.k])));
  return c.json({ newCount: (count.results[0] as { n: number }).n, latest: items });
});

mail.post('/messages/:id/cancel-schedule', async (c) => {
  const mb = c.get('mailbox').id;
  const id = c.req.param('id');
  const roles = await folderIdsByRole(c.env.DB, mb);
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `UPDATE messages SET status = 'draft', send_at = NULL, folder_id = ?, folder_changed_at = ?, updated_at = ?
      WHERE id = ? AND mailbox_id = ? AND status = 'scheduled'`,
  ).bind(roles.drafts, now, now, id, mb).run();
  const row = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ? AND mailbox_id = ?').bind(id, mb).first<MessageRow>();
  if (!row) throw notFound('Message not found');
  if (!res.meta.changes) throw new HttpError(409, 'NOT_SCHEDULED', 'This message is not scheduled (it may already be sending)');
  await recomputeThreads(c.env.DB, [row.thread_id]);
  return c.json(await loadMessageFull(c.env, origin(c.req.url), row));
});
