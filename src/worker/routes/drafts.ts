import { Hono } from 'hono';
import { z } from 'zod';
import { LIMITS, type ComposeMode } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { dedupeAddresses } from '../lib/addresses';
import {
  addressesForFts, attachmentToApi, deleteMessagesForever, folderIdsByRole, ftsInsertStmt, loadMessageFull,
  recomputeThreadStmts, recomputeThreads, type AttachmentRow, type MessageRow,
} from '../lib/db';
import { HttpError, notFound } from '../lib/errors';
import { htmlToText, makeSnippet } from '../lib/html';
import { jsonBody, zAddress, zId } from '../lib/validate';
import { normalizeSubject } from '../inbound/thread';
import { claimForSend, performSend, sendErrorStatus, validateDraft } from '../outbound/send';
import type { AppEnv } from '../types';

export const drafts = new Hono<AppEnv>();

const origin = (url: string) => new URL(url).origin;
const bytes = (s: string | null | undefined) => (s ? new TextEncoder().encode(s).byteLength : 0);
const EDITABLE = ['draft', 'failed'];

const DraftSchema = z.object({
  from: z.string().trim().toLowerCase().max(254),
  to: z.array(zAddress).max(LIMITS.maxRecipients),
  cc: z.array(zAddress).max(LIMITS.maxRecipients),
  bcc: z.array(zAddress).max(LIMITS.maxRecipients),
  subject: z.string().max(LIMITS.maxSubject).transform((s) => s.replace(/[\r\n]+/g, ' ')),
  html: z.string().max(10 * 1024 * 1024),
  text: z.string().max(10 * 1024 * 1024).optional(),
  parentId: zId.nullable().optional(),
  composeMode: z.enum(['new', 'reply', 'reply_all', 'forward']).optional(),
});
type DraftBody = z.infer<typeof DraftSchema>;

/** Display name for an identity: the mailbox display name, else the user's name. */
async function identityName(db: D1Database, mailboxId: string, from: string, fallback: string): Promise<string> {
  const row = await db.prepare(
    `SELECT m.display_name FROM mailboxes m WHERE m.id = ?1 AND (m.address = ?2 OR EXISTS (
       SELECT 1 FROM aliases a WHERE a.mailbox_id = m.id AND a.address = ?2 AND a.can_send = 1))`,
  ).bind(mailboxId, from).first<{ display_name: string }>();
  if (!row) throw new HttpError(400, 'INVALID_FROM', 'You cannot send from that address');
  return row.display_name || fallback;
}

function threadingHeaders(parent: MessageRow, mode: ComposeMode): { inReplyTo: string | null; references: string | null } {
  if (mode === 'forward' || !parent.message_id_hdr) return { inReplyTo: null, references: null };
  const refs = [...(parent.references_hdr ?? '').split(/\s+/).filter(Boolean), parent.message_id_hdr];
  const unique = [...new Set(refs)].slice(-50);
  return { inReplyTo: parent.message_id_hdr, references: unique.join(' ') };
}

async function writeDraftBody(env: Env, mb: string, id: string, b: DraftBody): Promise<{ key: string; text: string }> {
  const text = b.text ?? htmlToText(b.html);
  const key = `body/${mb}/${id}.json`;
  await env.BUCKET.put(key, JSON.stringify({ html: b.html, text }), { httpMetadata: { contentType: 'application/json' } });
  return { key, text };
}

async function loadDraft(db: D1Database, mb: string, id: string): Promise<MessageRow> {
  const row = await db.prepare('SELECT * FROM messages WHERE id = ? AND mailbox_id = ?').bind(id, mb).first<MessageRow>();
  if (!row || row.direction !== 'out') throw notFound('Draft not found');
  if (!EDITABLE.includes(row.status)) throw new HttpError(409, 'NOT_A_DRAFT', 'This message is no longer a draft');
  return row;
}

drafts.post('/drafts', async (c) => {
  const b = await jsonBody(c, DraftSchema);
  const mb = c.get('mailbox').id;
  const db = c.env.DB;
  const fromName = await identityName(db, mb, b.from, c.get('user').name);
  const roles = await folderIdsByRole(db, mb);
  const now = Date.now();
  const id = ulid(now);
  let parent: MessageRow | null = null;
  if (b.parentId) {
    parent = await db.prepare('SELECT * FROM messages WHERE id = ? AND mailbox_id = ?').bind(b.parentId, mb).first<MessageRow>();
    if (!parent) throw notFound('Parent message not found');
  }
  const mode: ComposeMode = b.composeMode ?? (parent ? 'reply' : 'new');
  const th = parent ? threadingHeaders(parent, mode) : { inReplyTo: null, references: null };
  const threadId = parent?.thread_id ?? ulid(now);
  const { key, text } = await writeDraftBody(c.env, mb, id, b);
  const to = dedupeAddresses(b.to), cc = dedupeAddresses(b.cc), bcc = dedupeAddresses(b.bcc);
  const stmts: D1PreparedStatement[] = [];
  if (!parent) {
    stmts.push(db.prepare('INSERT INTO threads (id, mailbox_id, subject, subject_norm, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(threadId, mb, b.subject, normalizeSubject(b.subject), now, now));
  }
  stmts.push(db.prepare(
    `INSERT INTO messages (id, mailbox_id, thread_id, folder_id, direction, status, in_reply_to, references_hdr, parent_id, compose_mode,
       from_email, from_name, to_json, cc_json, bcc_json, subject, snippet, body_key, size, is_read, date, created_at, updated_at, folder_changed_at)
     VALUES (?, ?, ?, ?, 'out', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).bind(id, mb, threadId, roles.drafts, th.inReplyTo, th.references, parent?.id ?? null, mode, b.from, fromName,
    JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), b.subject, makeSnippet(text), key, bytes(b.html) + bytes(text), now, now, now, now));
  stmts.push(ftsInsertStmt(db, { id, mailboxId: mb, subject: b.subject, addresses: addressesForFts({ email: b.from, name: fromName }, to, cc, bcc), body: text }));
  stmts.push(...recomputeThreadStmts(db, threadId));
  await db.batch(stmts);

  // Forwards carry the parent's regular attachments. Objects are copied so each row owns its key.
  if (parent && mode === 'forward') {
    const { results } = await db.prepare('SELECT * FROM attachments WHERE message_id = ? AND inline = 0').bind(parent.id).all<AttachmentRow>();
    let total = 0;
    const ins: D1PreparedStatement[] = [];
    for (const a of results.slice(0, LIMITS.maxAttachments)) {
      const obj = await c.env.BUCKET.get(a.r2_key);
      if (!obj) continue;
      const aid = ulid();
      const r2Key = `att/${mb}/${aid}`;
      await c.env.BUCKET.put(r2Key, await obj.arrayBuffer(), { httpMetadata: { contentType: a.mime_type } });
      total += a.size;
      ins.push(db.prepare('INSERT INTO attachments (id, message_id, mailbox_id, filename, mime_type, size, content_id, inline, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)')
        .bind(aid, id, mb, a.filename, a.mime_type, a.size, r2Key, Date.now()));
    }
    if (ins.length) {
      ins.push(db.prepare('UPDATE messages SET has_attachments = 1, size = size + ? WHERE id = ?').bind(total, id));
      await db.batch(ins);
    }
  }
  const row = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>();
  return c.json(await loadMessageFull(c.env, origin(c.req.url), row!), 201);
});

drafts.put('/drafts/:id', async (c) => {
  const b = await jsonBody(c, DraftSchema);
  const mb = c.get('mailbox').id;
  const db = c.env.DB;
  const row = await loadDraft(db, mb, c.req.param('id'));
  const fromName = await identityName(db, mb, b.from, c.get('user').name);
  const { key, text } = await writeDraftBody(c.env, mb, row.id, b);
  const to = dedupeAddresses(b.to), cc = dedupeAddresses(b.cc), bcc = dedupeAddresses(b.bcc);
  const att = await db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE message_id = ?').bind(row.id).first<number>('n');
  const now = Date.now();
  await db.batch([
    db.prepare(
      `UPDATE messages SET status = 'draft', error_code = NULL, error_message = NULL, from_email = ?, from_name = ?, to_json = ?, cc_json = ?,
         bcc_json = ?, subject = ?, snippet = ?, body_key = ?, size = ?, date = ?, updated_at = ? WHERE id = ?`,
    ).bind(b.from, fromName, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), b.subject, makeSnippet(text), key,
      bytes(b.html) + bytes(text) + (att ?? 0), now, now, row.id),
    db.prepare('DELETE FROM messages_fts WHERE message_id = ?').bind(row.id),
    ftsInsertStmt(db, { id: row.id, mailboxId: mb, subject: b.subject, addresses: addressesForFts({ email: b.from, name: fromName }, to, cc, bcc), body: text }),
    db.prepare("UPDATE threads SET subject_norm = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = ? AND status IN ('received','sent'))")
      .bind(normalizeSubject(b.subject), row.thread_id, row.thread_id),
    ...recomputeThreadStmts(db, row.thread_id),
  ]);
  const updated = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(row.id).first<MessageRow>();
  return c.json(await loadMessageFull(c.env, origin(c.req.url), updated!));
});

drafts.delete('/drafts/:id', async (c) => {
  const mb = c.get('mailbox').id;
  const row = await loadDraft(c.env.DB, mb, c.req.param('id'));
  await deleteMessagesForever(c.env, mb, [row.id]);
  return c.json({ ok: true });
});

drafts.post('/drafts/:id/attachments', async (c) => {
  const mb = c.get('mailbox').id;
  const db = c.env.DB;
  const row = await loadDraft(db, mb, c.req.param('id'));
  let form: Record<string, string | File | (string | File)[]>;
  try {
    form = await c.req.parseBody();
  } catch {
    throw new HttpError(400, 'INVALID_UPLOAD', 'Expected multipart/form-data');
  }
  const file = form['file'];
  if (!(file instanceof File)) throw new HttpError(400, 'INVALID_UPLOAD', 'Missing file field');
  const count = await db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?').bind(row.id).first<number>('n');
  if ((count ?? 0) >= LIMITS.maxAttachments) throw new HttpError(400, 'TOO_MANY_ATTACHMENTS', `At most ${LIMITS.maxAttachments} attachments`);
  if (row.size + file.size > LIMITS.maxMessageBytes) throw new HttpError(413, 'MESSAGE_TOO_LARGE', 'Attachments exceed the 25 MiB message limit');
  const now = Date.now();
  const aid = ulid(now);
  const r2Key = `att/${mb}/${aid}`;
  const mime = (file.type || 'application/octet-stream').toLowerCase().slice(0, 200);
  const filename = (file.name || 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 255);
  await c.env.BUCKET.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: mime } });
  await db.batch([
    db.prepare('INSERT INTO attachments (id, message_id, mailbox_id, filename, mime_type, size, content_id, inline, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)')
      .bind(aid, row.id, mb, filename, mime, file.size, r2Key, now),
    db.prepare('UPDATE messages SET has_attachments = 1, size = size + ?, updated_at = ? WHERE id = ?').bind(file.size, now, row.id),
    ...recomputeThreadStmts(db, row.thread_id),
  ]);
  const a = await db.prepare('SELECT * FROM attachments WHERE id = ?').bind(aid).first<AttachmentRow>();
  return c.json(await attachmentToApi(c.env, origin(c.req.url), a!), 201);
});

drafts.delete('/drafts/:id/attachments/:aid', async (c) => {
  const mb = c.get('mailbox').id;
  const db = c.env.DB;
  const row = await loadDraft(db, mb, c.req.param('id'));
  const a = await db.prepare('SELECT * FROM attachments WHERE id = ? AND message_id = ? AND mailbox_id = ?').bind(c.req.param('aid'), row.id, mb).first<AttachmentRow>();
  if (!a) throw notFound('Attachment not found');
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM attachments WHERE id = ?').bind(a.id),
    db.prepare(`UPDATE messages SET size = MAX(0, size - ?1), updated_at = ?2,
                  has_attachments = EXISTS (SELECT 1 FROM attachments WHERE message_id = ?3) WHERE id = ?3`)
      .bind(a.size, now, row.id),
    ...recomputeThreadStmts(db, row.thread_id),
  ]);
  const still = await db.prepare('SELECT 1 FROM attachments WHERE r2_key = ?').bind(a.r2_key).first();
  if (!still) await c.env.BUCKET.delete(a.r2_key);
  return c.json({ ok: true });
});

drafts.post('/drafts/:id/send', async (c) => {
  const body = await jsonBody(c, z.object({ sendAt: z.number().int().positive().optional() }));
  const mb = c.get('mailbox').id;
  const db = c.env.DB;
  const row = await loadDraft(db, mb, c.req.param('id'));
  await validateDraft(db, row);
  const now = Date.now();
  const o = origin(c.req.url);
  if (body.sendAt && body.sendAt > now + 10_000) {
    if (body.sendAt > now + 366 * 24 * 3600 * 1000) throw new HttpError(400, 'INVALID_SEND_AT', 'sendAt is too far in the future');
    const roles = await folderIdsByRole(db, mb);
    const res = await db.prepare(
      `UPDATE messages SET status = 'scheduled', send_at = ?, folder_id = ?, folder_changed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL
        WHERE id = ? AND status IN ('draft','failed')`,
    ).bind(body.sendAt, roles.scheduled, now, now, row.id).run();
    if (!res.meta.changes) throw new HttpError(409, 'NOT_A_DRAFT', 'This message is no longer a draft');
    await recomputeThreads(db, [row.thread_id]);
    const updated = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(row.id).first<MessageRow>();
    return c.json({ message: await loadMessageFull(c.env, o, updated!), status: 'scheduled' as const });
  }
  if (!(await claimForSend(db, row.id, ['draft', 'failed']))) throw new HttpError(409, 'NOT_A_DRAFT', 'This message is already being sent');
  const result = await performSend(c.env, row, [c.get('user').id]);
  if (!result.ok) throw new HttpError(sendErrorStatus(result.code), result.code, result.message);
  const updated = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(row.id).first<MessageRow>();
  return c.json({ message: await loadMessageFull(c.env, o, updated!), status: 'sent' as const });
});
