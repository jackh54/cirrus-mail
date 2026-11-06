import { Hono } from 'hono';
import { z } from 'zod';
import type { Folder, FolderRole, ThreadSummary } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import {
  attachmentToApi, decodeCursor, deleteMessagesForever, encodeCursor, loadBody, loadMessageFull, messageRowToFull,
  pageRowsToSummaries, pageSummariesSql, recomputeThreadStmts, recomputeThreads, threadLabelsSql, threadRowToSummary,
  type AttachmentRow, type MessageRow, type PageRow, type ThreadRow,
} from '../lib/db';
import { HttpError, notFound } from '../lib/errors';
import { jsonBody, zId } from '../lib/validate';
import { buildSearchSql, parseSearch } from '../search';
import { parseJsonAddresses } from '../lib/addresses';
import { authorizeMailbox, type Authz } from '../middleware/session';
import type { AppEnv } from '../types';

export const mail = new Hono<AppEnv>();

/**
 * Hot reads. Mounted before the mailbox guard: each handler calls authorizeMailbox, which runs the session and
 * membership check in the same D1 batch as the handler's reads and only hands back their results once access is
 * confirmed. Every read starts its FROM clause with `authz.from`, so it touches no mailbox rows unless access
 * holds. Read-only handlers only; everything else belongs on `mail`.
 */
export const mailReads = new Hono<AppEnv>();

const origin = (url: string) => new URL(url).origin;

// ---------- folders ----------

export function folderListStmts(db: D1Database, mb: string, authz: Authz): D1PreparedStatement[] {
  return [db.prepare(
    `SELECT f.id, f.name, f.role, f.sort, COALESCE(s.total, 0) AS total, COALESCE(s.unread, 0) AS unread
       FROM ${authz.from} folders f
       LEFT JOIN (SELECT folder_id, COUNT(*) AS total, SUM(is_read = 0) AS unread FROM ${authz.from} messages WHERE mailbox_id = ? GROUP BY folder_id) s
         ON s.folder_id = f.id
      WHERE f.mailbox_id = ? ORDER BY f.sort, f.name`,
  ).bind(...authz.params, ...authz.params, mb, mb)];
}

mailReads.get('/folders', async (c) => {
  const [folders] = await authorizeMailbox(c, (mb, authz) => folderListStmts(c.env.DB, mb, authz));
  return c.json(folders.results as unknown as Folder[]);
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
  const { id: mb, roles } = c.get('mailbox');
  const f = await customFolder(c.env.DB, mb, c.req.param('id'));
  const now = Date.now();
  // Messages in a deleted folder are kept and moved to Archive.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE messages SET folder_id = ?, folder_changed_at = ?, updated_at = ? WHERE folder_id = ?').bind(roles.archive, now, now, f.id),
    c.env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(f.id),
  ]);
  return c.json({ ok: true });
});

// ---------- thread listing ----------

const INBOX_SQL = "(SELECT id FROM folders WHERE mailbox_id = ? AND role = 'inbox')";
const TRASH_SPAM_SQL = "(SELECT id FROM folders WHERE mailbox_id = ? AND role IN ('trash','spam'))";

type ListRow = PageRow & { draft?: string | null };

/**
 * Threads appear in a folder when any of their messages is in it. They are sorted by the date of the
 * latest message *in that folder* (so `lastMessageAt` in the list is that date), newest first.
 *
 * Read-only statements (system folders are resolved in SQL, so they can share the authorization round trip);
 * `readThreadList` turns their results into the page.
 */
export function listThreadsStmts(
  db: D1Database, mb: string, opts: { folder?: string; label?: string; q?: string; cursor?: string; limit: number }, authz: Authz,
): D1PreparedStatement[] {
  const where: string[] = ['m.mailbox_id = ?'];
  const params: unknown[] = [...authz.params, mb];
  if (opts.label) {
    // A label lists its messages everywhere except Trash and Spam.
    where.push('m.id IN (SELECT message_id FROM message_labels WHERE label_id = ?)', `m.folder_id NOT IN ${TRASH_SPAM_SQL}`);
    params.push(opts.label, mb);
  } else if (opts.folder === 'starred') {
    where.push('m.is_starred = 1', `m.folder_id NOT IN ${TRASH_SPAM_SQL}`);
    params.push(mb);
  } else if (opts.folder) {
    where.push('m.folder_id = ?');
    params.push(opts.folder);
  } else if (opts.q) {
    where.push(`m.folder_id NOT IN ${TRASH_SPAM_SQL}`);
    params.push(mb);
  } else {
    where.push(`m.folder_id = ${INBOX_SQL}`);
    params.push(mb);
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
  const pageSql = `SELECT m.thread_id AS tid, MAX(m.date) AS k FROM ${authz.from} messages m WHERE ${where.join(' AND ')}
      GROUP BY m.thread_id ${having} ORDER BY k DESC, tid DESC LIMIT ?`;
  // In Drafts, a row shows the latest draft itself: its subject, snippet and recipients.
  const draftCol = !opts.label && opts.folder && opts.folder !== 'starred'
    ? `, CASE WHEN EXISTS (SELECT 1 FROM folders WHERE id = ? AND mailbox_id = ? AND role = 'drafts') THEN (
         SELECT json_object('subject', d.subject, 'snippet', d.snippet, 'to', d.to_json) FROM messages d
          WHERE +d.mailbox_id = ? AND +d.folder_id = ? AND d.thread_id = page.tid ORDER BY d.date DESC LIMIT 1) END AS draft`
    : '';
  const draftParams = draftCol ? [opts.folder, mb, mb, opts.folder] : [];
  const list = db.prepare(pageSummariesSql(pageSql, 'page.k DESC, page.tid DESC', draftCol)).bind(...params, mb, mb, ...draftParams, mb);
  // A named folder or label must exist in this mailbox (404 otherwise); its check runs first in the same batch.
  if (opts.label) return [db.prepare(`SELECT l.id FROM ${authz.from} labels l WHERE l.id = ? AND l.mailbox_id = ?`).bind(...authz.params, opts.label, mb), list];
  return draftCol ? [db.prepare(`SELECT f.id FROM ${authz.from} folders f WHERE f.id = ? AND f.mailbox_id = ?`).bind(...authz.params, opts.folder, mb), list] : [list];
}

export function readThreadList(results: D1Result[], limit: number, what = 'Folder'): { items: ThreadSummary[]; nextCursor: string | null } {
  if (results.length === 2 && !results[0].results.length) throw notFound(`${what} not found`);
  const rows = results[results.length - 1].results as unknown as ListRow[];
  const page = rows.slice(0, limit);
  const drafts = new Map(page.filter((r) => r.draft).map((r) => [r.tid, JSON.parse(r.draft!) as { subject: string; snippet: string; to: string }]));
  const items = pageRowsToSummaries(page).map((t) => {
    const d = drafts.get(t.id);
    return d ? { ...t, subject: d.subject, snippet: d.snippet, participants: parseJsonAddresses(d.to) } : t;
  });
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.k, last.tid) : null };
}

mailReads.get('/threads', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const q = c.req.query('q')?.trim() || undefined;
  const opts = { folder: c.req.query('folder') || undefined, label: c.req.query('label') || undefined, q, cursor: c.req.query('cursor'), limit };
  return c.json(readThreadList(await authorizeMailbox(c, (mb, authz) => listThreadsStmts(c.env.DB, mb, opts, authz)), limit, opts.label ? 'Label' : 'Folder'));
});

export function threadDetailStmts(db: D1Database, mb: string, tid: string, authz: Authz): D1PreparedStatement[] {
  return [
    db.prepare(`SELECT t.*, ${threadLabelsSql('t.id')} AS label_ids FROM ${authz.from} threads t WHERE t.id = ? AND t.mailbox_id = ?`).bind(mb, ...authz.params, tid, mb),
    db.prepare(`SELECT m.* FROM ${authz.from} messages m WHERE m.thread_id = ? AND m.mailbox_id = ? ORDER BY m.date ASC, m.id ASC`).bind(...authz.params, tid, mb),
    db.prepare(`SELECT a.* FROM ${authz.from} messages m CROSS JOIN attachments a ON a.message_id = m.id
                 WHERE m.thread_id = ? AND a.mailbox_id = ? ORDER BY a.created_at, a.id`).bind(...authz.params, tid, mb),
  ];
}

mailReads.get('/threads/:tid', async (c) => {
  const tid = c.req.param('tid');
  const [thread, msgs, atts] = await authorizeMailbox(c, (mb, authz) => threadDetailStmts(c.env.DB, mb, tid, authz));
  const t = thread.results[0] as unknown as (ThreadRow & { label_ids: string }) | undefined;
  if (!t) throw notFound('Thread not found');
  const rows = msgs.results as unknown as MessageRow[];
  const o = origin(c.req.url);
  const attByMsg = new Map<string, AttachmentRow[]>();
  for (const a of atts.results as unknown as AttachmentRow[]) attByMsg.set(a.message_id, [...(attByMsg.get(a.message_id) ?? []), a]);
  // All R2 bodies in parallel.
  const messages = await Promise.all(rows.map(async (m) => {
    const [body, list] = await Promise.all([loadBody(c.env, m.body_key), Promise.all((attByMsg.get(m.id) ?? []).map((a) => attachmentToApi(c.env, o, a)))]);
    return messageRowToFull(m, body, list, o);
  }));
  const summary = threadRowToSummary(t, [...new Set(rows.map((m) => m.folder_id))], undefined, JSON.parse(t.label_ids) as string[]);
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
  const { id: mb, roles } = c.get('mailbox');
  const db = c.env.DB;
  const ids = [...new Set(body.threadIds)];
  const ph = ids.map(() => '?').join(',');
  const ownedStmt = db.prepare(`SELECT id FROM threads WHERE mailbox_id = ? AND id IN (${ph})`).bind(mb, ...ids);
  // Every write is scoped to this mailbox, so ids from another mailbox match nothing.
  // The unary `+` keeps SQLite on the thread index instead of scanning the whole mailbox.
  const scope = `+mailbox_id = ? AND thread_id IN (${ph})`;
  const now = Date.now();

  if (body.action === 'delete_forever') {
    const [owned, msgs] = await db.batch([
      ownedStmt,
      db.prepare(`SELECT id FROM messages WHERE ${scope} AND folder_id IN (?, ?)`).bind(mb, ...ids, roles.trash, roles.spam),
    ]);
    if (!owned.results.length) throw notFound('Thread not found');
    const results = msgs.results as { id: string }[];
    if (!results.length) throw new HttpError(400, 'NOT_IN_TRASH', 'Only messages in Trash or Spam can be deleted forever');
    await deleteMessagesForever(c.env, mb, results.map((r) => r.id));
    return c.json({ ok: true });
  }

  let target: { id: string; role: FolderRole | null } | null = null;
  if (body.action === 'move') {
    const [owned, folder] = await db.batch([
      ownedStmt,
      db.prepare('SELECT id, role FROM folders WHERE id = ? AND mailbox_id = ?').bind(body.folderId ?? '', mb),
    ]);
    if (!owned.results.length) throw notFound('Thread not found');
    if (!body.folderId) throw new HttpError(400, 'FOLDER_REQUIRED', 'folderId is required for move');
    target = (folder.results[0] as { id: string; role: FolderRole | null } | undefined) ?? null;
    if (!target) throw notFound('Folder not found');
    if (target.role === 'drafts' || target.role === 'scheduled') throw new HttpError(400, 'INVALID_FOLDER', 'Messages cannot be moved there');
  }

  const move = (to: string, extra = '', extraParams: unknown[] = []) =>
    db.prepare(`UPDATE messages SET folder_id = ?, folder_changed_at = ?, updated_at = ? WHERE ${scope} AND folder_id != ? ${extra}`)
      .bind(to, now, now, mb, ...ids, to, ...extraParams);
  const NOT_OUTBOX = "AND status NOT IN ('draft','scheduled','sending')";
  let writes: D1PreparedStatement[];
  switch (body.action) {
    case 'read':
    case 'unread':
      writes = [db.prepare(`UPDATE messages SET is_read = ?, updated_at = ? WHERE ${scope}`).bind(body.action === 'read' ? 1 : 0, now, mb, ...ids)];
      break;
    case 'star':
    case 'unstar':
      writes = [db.prepare(`UPDATE messages SET is_starred = ?, updated_at = ? WHERE ${scope} ${NOT_OUTBOX}`).bind(body.action === 'star' ? 1 : 0, now, mb, ...ids)];
      break;
    case 'archive':
      writes = [move(roles.archive, 'AND folder_id = ?', [roles.inbox])];
      break;
    case 'trash':
      // Trashing cancels any scheduled send in the thread so the cron cannot deliver it from Trash.
      writes = [
        db.prepare(`UPDATE messages SET status = 'draft', send_at = NULL WHERE ${scope} AND status = 'scheduled'`).bind(mb, ...ids),
        move(roles.trash),
      ];
      break;
    case 'spam':
      writes = [move(roles.spam, "AND direction = 'in' AND folder_id != ?", [roles.trash])];
      break;
    case 'not_spam':
      writes = [move(roles.inbox, 'AND folder_id = ?', [roles.spam])];
      break;
    case 'move':
      writes = [move(target!.id, NOT_OUTBOX)];
      break;
  }
  // One round trip: the ownership check (read before the writes in the same transaction), the writes and the
  // thread aggregates. When nothing is owned, every statement matched nothing and the result is a 404 as before.
  const [owned] = await db.batch([ownedStmt, ...writes, ...ids.flatMap((t) => recomputeThreadStmts(db, t, mb))]);
  if (!owned.results.length) throw notFound('Thread not found');
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

export function pollStmts(db: D1Database, mb: string, since: number, authz: Authz): D1PreparedStatement[] {
  return [
    db.prepare(`SELECT COUNT(*) AS n FROM ${authz.from} messages m WHERE m.mailbox_id = ? AND m.folder_id = ${INBOX_SQL} AND m.is_read = 0 AND m.created_at > ?`)
      .bind(...authz.params, mb, mb, since),
    db.prepare(pageSummariesSql(
      `SELECT m.thread_id AS tid, MAX(m.date) AS k FROM ${authz.from} messages m WHERE m.mailbox_id = ? AND m.folder_id = ${INBOX_SQL} AND m.created_at > ?
        GROUP BY m.thread_id ORDER BY k DESC LIMIT 10`, 'page.k DESC')).bind(...authz.params, mb, mb, since, mb, mb, mb),
  ];
}

/** Nearly free when nothing changed: one round trip with the authorization, two indexed range reads that find nothing. */
mailReads.get('/poll', async (c) => {
  const since = Number(c.req.query('since')) || 0;
  const [count, latest] = await authorizeMailbox(c, (mb, authz) => pollStmts(c.env.DB, mb, since, authz));
  return c.json({ newCount: (count.results[0] as { n: number }).n, latest: pageRowsToSummaries(latest.results as unknown as PageRow[]) });
});

mail.post('/messages/:id/cancel-schedule', async (c) => {
  const { id: mb, roles } = c.get('mailbox');
  const id = c.req.param('id');
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
