import { Hono } from 'hono';
import { z } from 'zod';
import { LABEL_COLORS, LABEL_LIMITS, type Label } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { HttpError, notFound } from '../lib/errors';
import { jsonBody, zHeaderText, zId } from '../lib/validate';
import { authorizeMailbox, type Authz } from '../middleware/session';
import type { AppEnv } from '../types';

/** Hot read (rail): authorizes itself in the same D1 round trip, like the folder list. Mounted before the mailbox guard. */
export const labelReads = new Hono<AppEnv>();
export const labels = new Hono<AppEnv>();

const LabelName = zHeaderText(LABEL_LIMITS.maxName, 1);
const LabelColorSchema = z.enum(LABEL_COLORS);

export function labelListStmts(db: D1Database, mb: string, authz: Authz): D1PreparedStatement[] {
  return [db.prepare(
    `SELECT l.id, l.name, l.color,
            (SELECT COUNT(*) FROM message_labels ml JOIN messages m ON m.id = ml.message_id
              WHERE ml.label_id = l.id AND m.is_read = 0
                AND m.folder_id NOT IN (SELECT id FROM folders WHERE mailbox_id = ? AND role IN ('trash','spam'))) AS unread
       FROM ${authz.from} labels l WHERE l.mailbox_id = ? ORDER BY l.name`,
  ).bind(mb, ...authz.params, mb)];
}

labelReads.get('/labels', async (c) => {
  const [rows] = await authorizeMailbox(c, (mb, authz) => labelListStmts(c.env.DB, mb, authz));
  return c.json(rows.results as unknown as Label[]);
});

const exists = () => new HttpError(409, 'LABEL_EXISTS', 'A label with that name already exists');

labels.post('/labels', async (c) => {
  const body = await jsonBody(c, z.object({ name: LabelName, color: LabelColorSchema }));
  const mb = c.get('mailbox').id;
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM labels WHERE mailbox_id = ?').bind(mb).first<number>('n');
  if ((count ?? 0) >= LABEL_LIMITS.maxPerMailbox) throw new HttpError(400, 'TOO_MANY_LABELS', `A mailbox can have at most ${LABEL_LIMITS.maxPerMailbox} labels`);
  const id = ulid();
  try {
    await c.env.DB.prepare('INSERT INTO labels (id, mailbox_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, mb, body.name, body.color, Date.now()).run();
  } catch {
    throw exists();
  }
  const label: Label = { id, name: body.name, color: body.color, unread: 0 };
  return c.json(label, 201);
});

labels.patch('/labels/:id', async (c) => {
  const body = await jsonBody(c, z.object({ name: LabelName.optional(), color: LabelColorSchema.optional() }));
  const mb = c.get('mailbox').id;
  const cur = await c.env.DB.prepare('SELECT id, name, color FROM labels WHERE id = ? AND mailbox_id = ?').bind(c.req.param('id'), mb).first<{ id: string; name: string; color: Label['color'] }>();
  if (!cur) throw notFound('Label not found');
  const name = body.name ?? cur.name;
  const color = body.color ?? cur.color;
  try {
    await c.env.DB.prepare('UPDATE labels SET name = ?, color = ? WHERE id = ? AND mailbox_id = ?').bind(name, color, cur.id, mb).run();
  } catch {
    throw exists();
  }
  const unread = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM message_labels ml JOIN messages m ON m.id = ml.message_id
      WHERE ml.label_id = ? AND m.is_read = 0 AND m.folder_id NOT IN (SELECT id FROM folders WHERE mailbox_id = ? AND role IN ('trash','spam'))`,
  ).bind(cur.id, mb).first<number>('n');
  const label: Label = { id: cur.id, name, color, unread: unread ?? 0 };
  return c.json(label);
});

/** Removes the label from every message, then the label itself. */
labels.delete('/labels/:id', async (c) => {
  const mb = c.get('mailbox').id;
  const id = c.req.param('id');
  const [, del] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM message_labels WHERE label_id IN (SELECT id FROM labels WHERE id = ? AND mailbox_id = ?)').bind(id, mb),
    c.env.DB.prepare('DELETE FROM labels WHERE id = ? AND mailbox_id = ?').bind(id, mb),
  ]);
  if (!del.meta.changes) throw notFound('Label not found');
  return c.json({ ok: true });
});

const ApplySchema = z.object({
  threadIds: z.array(zId).min(1).max(500),
  add: z.array(zId).max(20).optional(),
  remove: z.array(zId).max(20).optional(),
}).refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, 'add or remove is required')
  .refine((b) => !(b.add ?? []).some((a) => (b.remove ?? []).includes(a)), 'A label cannot be both added and removed');

/**
 * Adds and/or removes labels on every message of the given threads, in one D1 round trip: the ownership checks
 * run before the writes in the same transaction, and every write is guarded so it only happens when all the
 * labels belong to this mailbox. Thread ids from another mailbox match nothing.
 */
labels.post('/threads/labels', async (c) => {
  const body = await jsonBody(c, ApplySchema);
  const mb = c.get('mailbox').id;
  const db = c.env.DB;
  const ids = [...new Set(body.threadIds)];
  const add = [...new Set(body.add ?? [])];
  const remove = [...new Set(body.remove ?? [])];
  const all = [...add, ...remove];
  const ph = (xs: unknown[]) => xs.map(() => '?').join(',');
  const allOk = `(SELECT COUNT(*) FROM labels WHERE mailbox_id = ? AND id IN (${ph(all)})) = ${all.length}`;
  // The unary `+` keeps SQLite on the thread index instead of scanning the whole mailbox.
  const msgs = `SELECT id FROM messages WHERE +mailbox_id = ? AND thread_id IN (${ph(ids)})`;
  const stmts: D1PreparedStatement[] = [
    db.prepare(`SELECT id FROM threads WHERE mailbox_id = ? AND id IN (${ph(ids)})`).bind(mb, ...ids),
    db.prepare(`SELECT id FROM labels WHERE mailbox_id = ? AND id IN (${ph(all)})`).bind(mb, ...all),
  ];
  if (add.length) {
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO message_labels (message_id, label_id)
       SELECT m.id, l.id FROM (${msgs}) m CROSS JOIN labels l WHERE l.mailbox_id = ? AND l.id IN (${ph(add)}) AND ${allOk}`,
    ).bind(mb, ...ids, mb, ...add, mb, ...all));
  }
  if (remove.length) {
    stmts.push(db.prepare(
      `DELETE FROM message_labels WHERE label_id IN (${ph(remove)}) AND message_id IN (${msgs}) AND ${allOk}`,
    ).bind(...remove, mb, ...ids, mb, ...all));
  }
  const [owned, ownedLabels] = await db.batch(stmts);
  if (!owned.results.length) throw notFound('Thread not found');
  if (ownedLabels.results.length !== all.length) throw notFound('Label not found');
  return c.json({ ok: true });
});
