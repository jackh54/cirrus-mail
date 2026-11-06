// mbox import processing (cron). The uploaded file sits in R2; each tick reads it in byte ranges from a persisted
// cursor (always the offset of a message start, so a message cut by the window is simply read again), stores each
// message the way inbound mail is stored, and stops at a time or message budget. Re-running is safe: messages are
// deduped by Message-ID (or content hash).
import PostalMime, { decodeWords } from 'postal-mime';
import { LABEL_COLORS, LABEL_LIMITS, LIMITS, type Address, type LabelColor } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { contentHash, toBytes } from '../inbound/handler';
import { SPAM_THRESHOLD } from '../inbound/spam';
import { findThread, normalizeSubject, parseMessageIds } from '../inbound/thread';
import { dedupeAddresses, fromParsed, normalizeEmail } from '../lib/addresses';
import { addressesForFts, folderIdsByRole, ftsInsertStmts, inlineBodyJson, recomputeThreadStmts } from '../lib/db';
import { htmlToText, makeSnippet } from '../lib/html';
import { mapGmailLabels, parseSeparatorDate, scanMbox, unescapeMboxrd } from './format';

export const IMPORT_BUDGET_MS = 20_000;
export const IMPORT_MAX_MESSAGES = 500;
export const IMPORT_WINDOW_BYTES = 8 * 1024 * 1024;
const LEASE_MS = 90_000;
const STALE_UPLOAD_MS = 3 * 24 * 3600 * 1000;
const MIN_DATE = Date.UTC(1990, 0, 1);
const MAX_ERROR_SAMPLES = 20;
const MAX_FAILED_TICKS = 10;

export interface ImportRow {
  id: string; mailbox_id: string; user_id: string; status: string; filename: string; r2_key: string; upload_id: string | null;
  size: number; folder_id: string | null; mark_read: number; parts_json: string; cursor: number; skipping: number;
  imported: number; duplicates: number; skipped: number; error_count: number; errors_json: string; lease_until: number; consecutive_failures: number;
  created_at: number; updated_at: number; finished_at: number | null;
}

export interface ProcessOpts {
  budgetMs?: number;
  maxMessages?: number;
  windowBytes?: number;
  /** Clock for the time budget (tests). */
  clock?: () => number;
}

interface Ctx {
  mailboxId: string;
  roles: Record<string, string>;
  target: { id: string; role: string | null };
  markRead: boolean;
  ownAddresses: Set<string>;
  labels: Map<string, string>;
}

type Outcome = { kind: 'imported' | 'duplicate' | 'skipped' } | { kind: 'error'; reason: string };

/** Ends an import: removes the source object and records the final state. */
async function finish(env: Env, row: ImportRow, status: 'done' | 'failed', reason?: string): Promise<void> {
  const errors = JSON.parse(row.errors_json) as string[];
  if (reason && errors.length < MAX_ERROR_SAMPLES) errors.push(reason);
  await env.DB.prepare(
    `UPDATE mbox_imports SET status = ?, errors_json = ?, error_count = error_count + ?, lease_until = 0, upload_id = NULL, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'`,
  ).bind(status, JSON.stringify(errors), reason ? 1 : 0, Date.now(), Date.now(), row.id).run();
  await env.BUCKET.delete(row.r2_key).catch(() => undefined);
}

/** Ends stale half-uploaded imports, so they do not block their mailbox forever. */
async function expireUploads(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, r2_key, upload_id FROM mbox_imports WHERE status = 'uploading' AND updated_at < ? LIMIT 20")
    .bind(now - STALE_UPLOAD_MS).all<{ id: string; r2_key: string; upload_id: string | null }>();
  for (const r of results) {
    if (r.upload_id) await env.BUCKET.resumeMultipartUpload(r.r2_key, r.upload_id).abort().catch(() => undefined);
    await env.DB.prepare("UPDATE mbox_imports SET status = 'cancelled', upload_id = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'uploading'")
      .bind(now, now, r.id).run();
  }
}

/**
 * One cron step: ends stale uploads, then works on the least recently served import for up to the budget.
 * One import per tick keeps the tick bounded; with several mailboxes importing they take turns.
 */
export async function processMboxImports(env: Env, opts: ProcessOpts = {}): Promise<void> {
  const clock = opts.clock ?? Date.now;
  const now = clock();
  await expireUploads(env, now);
  const row = await env.DB.prepare("SELECT * FROM mbox_imports WHERE status = 'processing' AND lease_until < ? ORDER BY updated_at, id LIMIT 1")
    .bind(now).first<ImportRow>();
  if (!row) return;
  const claim = await env.DB.prepare("UPDATE mbox_imports SET lease_until = ? WHERE id = ? AND status = 'processing' AND lease_until < ?")
    .bind(now + LEASE_MS, row.id, now).run();
  if (!claim.meta.changes) return;
  try {
    await runImport(env, row, opts);
    if (row.consecutive_failures) {
      await env.DB.prepare("UPDATE mbox_imports SET consecutive_failures = 0 WHERE id = ? AND status = 'processing'").bind(row.id).run();
    }
  } catch (e) {
    console.error('mbox import error', (e as Error).name);
    await failTick(env, row).catch(() => undefined);
  }
}

/** An unexpected error ends only this tick: the lease is released and the next tick retries, until too many fail in a row. */
async function failTick(env: Env, row: ImportRow): Promise<void> {
  const failures = await env.DB.prepare(
    "UPDATE mbox_imports SET consecutive_failures = consecutive_failures + 1, lease_until = 0, updated_at = ? WHERE id = ? AND status = 'processing'",
  ).bind(Date.now(), row.id).run().then(() => env.DB.prepare('SELECT consecutive_failures FROM mbox_imports WHERE id = ?').bind(row.id).first<number>('consecutive_failures'));
  if ((failures ?? 0) >= MAX_FAILED_TICKS) await finish(env, row, 'failed', 'internal_error');
}

async function loadCtx(env: Env, row: ImportRow): Promise<Ctx> {
  const db = env.DB;
  const mb = row.mailbox_id;
  const [roles, own, labels, target] = await Promise.all([
    folderIdsByRole(db, mb),
    db.prepare('SELECT address FROM mailboxes WHERE id = ?1 UNION SELECT address FROM aliases WHERE mailbox_id = ?1').bind(mb).all<{ address: string }>(),
    db.prepare('SELECT id, name FROM labels WHERE mailbox_id = ?').bind(mb).all<{ id: string; name: string }>(),
    row.folder_id ? db.prepare('SELECT id, role FROM folders WHERE id = ? AND mailbox_id = ?').bind(row.folder_id, mb).first<{ id: string; role: string | null }>() : null,
  ]);
  return {
    mailboxId: mb, roles, markRead: !!row.mark_read,
    target: target && target.role !== 'drafts' && target.role !== 'scheduled' ? target : { id: roles.archive, role: 'archive' },
    ownAddresses: new Set(own.results.map((r) => r.address.toLowerCase())),
    labels: new Map(labels.results.map((l) => [l.name.toLowerCase(), l.id])),
  };
}

function labelColor(name: string): LabelColor {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LABEL_COLORS[h % LABEL_COLORS.length];
}

/** The id of the mailbox label with this name (any case), created when missing and the mailbox is under its label limit. */
async function ensureLabel(env: Env, c: Ctx, name: string): Promise<string | null> {
  const key = name.toLowerCase();
  const known = c.labels.get(key);
  if (known) return known;
  if (c.labels.size >= LABEL_LIMITS.maxPerMailbox) return null;
  await env.DB.prepare('INSERT OR IGNORE INTO labels (id, mailbox_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ulid(), c.mailboxId, name, labelColor(name), Date.now()).run();
  const id = await env.DB.prepare('SELECT id FROM labels WHERE mailbox_id = ? AND name = ?').bind(c.mailboxId, name).first<string>('id');
  if (id) c.labels.set(key, id);
  return id;
}

/** The message's own Date, else the separator line's, clamped to [1990, now + 5 minutes]. */
export function importDate(header: string | undefined, sepLine: string, now: number): number {
  const t = header ? Date.parse(header) : NaN;
  const d = Number.isFinite(t) ? t : (parseSeparatorDate(sepLine) ?? now);
  return Math.min(Math.max(d, MIN_DATE), now + 5 * 60 * 1000);
}

/** Stores one message. Deliberately skips filters, auto-reply, push, send counts and spam scoring. */
async function importOne(env: Env, c: Ctx, raw: Uint8Array, sepLine: string): Promise<Outcome> {
  const db = env.DB;
  const now = Date.now();
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  } catch {
    return { kind: 'error', reason: 'parse_error' };
  }
  const gmailHdr = email.headers.find((h) => h.key === 'x-gmail-labels')?.value ?? null;
  const gm = gmailHdr === null ? null : mapGmailLabels(decodeWords(gmailHdr));
  if (gm?.folder === 'drafts') return { kind: 'skipped' };

  const msgId = parseMessageIds(email.messageId)[0] ?? null;
  const from: Address = fromParsed(email.from)[0] ?? { email: '' };
  const to = dedupeAddresses(fromParsed(email.to));
  const cc = dedupeAddresses(fromParsed(email.cc));
  const subject = (email.subject ?? '').slice(0, LIMITS.maxSubject);
  const date = importDate(email.date, sepLine, now);
  const createdAt = Math.min(date, now - 1);
  const hash = await contentHash(raw, [msgId, from.email, to.map((a) => a.email), cc.map((a) => a.email), subject, email.date ?? '']);

  const dup = msgId
    ? await db.prepare('SELECT 1 FROM messages WHERE mailbox_id = ? AND message_id_hdr = ? LIMIT 1').bind(c.mailboxId, msgId).first()
    : await db.prepare('SELECT 1 FROM messages WHERE mailbox_id = ? AND content_hash = ? LIMIT 1').bind(c.mailboxId, hash).first();
  if (dup) return { kind: 'duplicate' };

  let folderId: string;
  let role: string | null;
  if (gm) {
    folderId = c.roles[gm.folder];
    role = gm.folder;
  } else {
    folderId = c.target.id;
    role = c.target.role;
  }
  const outgoing = role === 'sent';
  const isRead = outgoing ? 1 : gm ? (gm.unread ? 0 : 1) : (c.markRead ? 1 : 0);
  const starred = gm?.starred ? 1 : 0;
  const spamScore = role === 'spam' ? SPAM_THRESHOLD : 0;

  const labelIds: string[] = [];
  for (const name of gm?.labels ?? []) {
    const id = await ensureLabel(env, c, name);
    if (id) labelIds.push(id);
  }

  const subjectNorm = normalizeSubject(subject);
  const participants = [from, ...to, ...cc].map((a) => a.email.toLowerCase());
  const references = parseMessageIds(email.references);
  const inReplyTo = parseMessageIds(email.inReplyTo);
  const existing = await findThread(db, { mailboxId: c.mailboxId, inReplyTo, references, subjectNorm, participants, ownAddresses: c.ownAddresses, now: date });

  const text = email.text ?? (email.html ? htmlToText(email.html) : '');
  const html = email.html ?? null;
  const attachmentsAll = email.attachments.slice(0, 100);
  const isInlinePart = (a: (typeof attachmentsAll)[number]) => !!a.contentId && (a.disposition === 'inline' || !!a.related);
  const hasAttachments = attachmentsAll.some((a) => !isInlinePart(a));
  const id = ulid(date);
  const threadId = existing ?? ulid(date);
  const rawKey = `raw/${c.mailboxId}/${id}.eml`;
  const bodyKey = `body/${c.mailboxId}/${id}.json`;
  const atts = attachmentsAll.map((a) => {
    const aid = ulid(date);
    const bytes = toBytes(a.content);
    return {
      id: aid, bytes, key: `att/${c.mailboxId}/${aid}`,
      filename: (a.filename || (a.mimeType.startsWith('image/') ? 'image' : 'attachment')).replace(/[\r\n]/g, ' ').slice(0, 255),
      mime: (a.mimeType || 'application/octet-stream').toLowerCase().slice(0, 200),
      contentId: a.contentId ? a.contentId.replace(/^<|>$/g, '').slice(0, 300) : null,
      inline: isInlinePart(a) ? 1 : 0,
    };
  });
  const r2Keys = [rawKey, bodyKey, ...atts.map((a) => a.key)];
  await Promise.all([
    env.BUCKET.put(rawKey, raw, { httpMetadata: { contentType: 'message/rfc822' } }),
    env.BUCKET.put(bodyKey, JSON.stringify({ html, text }), { httpMetadata: { contentType: 'application/json' } }),
    ...atts.map((a) => env.BUCKET.put(a.key, a.bytes, { httpMetadata: { contentType: a.mime } })),
  ]);

  // A custom target folder may have been deleted while the import ran: fall back to Archive for this and later messages.
  if (!gm && role === null && !(await db.prepare('SELECT 1 FROM folders WHERE id = ? AND mailbox_id = ?').bind(folderId, c.mailboxId).first())) {
    c.target = { id: c.roles.archive, role: 'archive' };
    folderId = c.target.id;
    role = 'archive';
  }

  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(db.prepare('INSERT INTO threads (id, mailbox_id, subject, subject_norm, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(threadId, c.mailboxId, subject, subjectNorm, date, now));
  }
  // created_at is the message date, but never later than a millisecond ago (the date may be up to 5 minutes ahead),
  // so the new-mail poll (created_at > since) neither announces an import nor moves its cursor into the future.
  // folder_changed_at is now, so imported Trash and Spam get their full 30 days.
  stmts.push(db.prepare(
    `INSERT INTO messages (id, mailbox_id, thread_id, folder_id, direction, status, message_id_hdr, in_reply_to, references_hdr,
       from_email, from_name, to_json, cc_json, bcc_json, reply_to, subject, snippet, body_key, body_inline, raw_key, size, has_attachments,
       is_read, is_starred, spam_score, sent_at, date, display_date, content_hash, created_at, updated_at, folder_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, c.mailboxId, threadId, folderId, outgoing ? 'out' : 'in', outgoing ? 'sent' : 'received', msgId, inReplyTo[0] ?? null,
    references.length ? references.join(' ').slice(0, 8000) : null, from.email, from.name ?? '', JSON.stringify(to), JSON.stringify(cc),
    email.replyTo?.length ? fromParsed(email.replyTo).map((a) => a.email).join(', ') : null, subject, makeSnippet(text), bodyKey,
    inlineBodyJson(html, text), rawKey, raw.byteLength, hasAttachments ? 1 : 0, isRead, starred, spamScore, outgoing ? date : null,
    date, date, hash, createdAt, createdAt, now));
  for (const a of atts) {
    stmts.push(db.prepare('INSERT INTO attachments (id, message_id, mailbox_id, filename, mime_type, size, content_id, inline, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(a.id, id, c.mailboxId, a.filename, a.mime, a.bytes.byteLength, a.contentId, a.inline, a.key, date));
  }
  // Selected from labels so a label deleted since it was cached is skipped rather than failing the whole message.
  const labelAt = stmts.length;
  for (const labelId of labelIds) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?, id FROM labels WHERE id = ? AND mailbox_id = ?').bind(id, labelId, c.mailboxId));
  }
  stmts.push(...ftsInsertStmts(db, { id, mailboxId: c.mailboxId, subject, addresses: addressesForFts(from, to, cc), body: text }));
  stmts.push(...recomputeThreadStmts(db, threadId));
  try {
    const res = await db.batch(stmts);
    // A label link that matched nothing means the label is gone: forget it, so ensureLabel looks it up again.
    labelIds.forEach((labelId, i) => {
      if (res[labelAt + i].meta.changes) return;
      for (const [name, cached] of c.labels) if (cached === labelId) c.labels.delete(name);
    });
  } catch (e) {
    await env.BUCKET.delete(r2Keys).catch(() => undefined);
    throw e;
  }
  return { kind: 'imported' };
}

const decoder = new TextDecoder('latin1');

/** Reads and imports from the cursor until the budget is used or the file ends. */
async function runImport(env: Env, row: ImportRow, opts: ProcessOpts): Promise<void> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? IMPORT_BUDGET_MS);
  const maxMessages = opts.maxMessages ?? IMPORT_MAX_MESSAGES;
  const baseWindow = opts.windowBytes ?? IMPORT_WINDOW_BYTES;
  const maxWindow = Math.max(baseWindow, LIMITS.maxMessageBytes + 1024 * 1024);
  const c = await loadCtx(env, row);

  let cursor = row.cursor;
  let skipping = !!row.skipping;
  const n = { imported: row.imported, duplicates: row.duplicates, skipped: row.skipped, errors: row.error_count };
  const samples = JSON.parse(row.errors_json) as string[];
  const note = (reason: string) => {
    n.errors++;
    if (samples.length < MAX_ERROR_SAMPLES) samples.push(reason);
  };
  let handled = 0;
  let window = baseWindow;
  let live = true;

  /** Saves the cursor and counters; false when the import was cancelled meanwhile. */
  const persist = async (release: boolean): Promise<boolean> => {
    const res = await env.DB.prepare(
      `UPDATE mbox_imports SET cursor = ?, skipping = ?, imported = ?, duplicates = ?, skipped = ?, error_count = ?, errors_json = ?,
         lease_until = ?, updated_at = ? WHERE id = ? AND status = 'processing'`,
    ).bind(cursor, skipping ? 1 : 0, n.imported, n.duplicates, n.skipped, n.errors, JSON.stringify(samples),
      release ? 0 : clock() + LEASE_MS, Date.now(), row.id).run();
    live = res.meta.changes > 0;
    return live;
  };

  while (cursor < row.size) {
    if (cursor !== row.cursor && (clock() >= deadline || handled >= maxMessages)) break;
    const obj = await env.BUCKET.get(row.r2_key, { range: { offset: cursor, length: Math.min(window, row.size - cursor) } });
    if (!obj) {
      if (await persist(false)) await finish(env, { ...row, errors_json: JSON.stringify(samples) }, 'failed', 'source_missing');
      return;
    }
    const buf = new Uint8Array(await obj.arrayBuffer());
    const atEnd = cursor + buf.length >= row.size;
    if (cursor === 0 && !skipping && decoder.decode(buf.subarray(0, 5)) !== 'From ') {
      if (await persist(false)) await finish(env, { ...row, errors_json: JSON.stringify(samples) }, 'failed', 'not_an_mbox_file');
      return;
    }

    if (skipping) {
      // Past an oversize message: look for the next separator. Windows overlap by 8 bytes so a separator is never cut.
      const sc = scanMbox(buf, atEnd, false);
      const next = sc.messages.length ? sc.messages[0].sep : (!atEnd && sc.consumed > 0 ? sc.consumed : -1);
      if (next >= 0) {
        cursor += next;
        skipping = false;
      } else cursor = atEnd ? row.size : cursor + Math.max(1, buf.length - 8);
      window = baseWindow;
      continue;
    }

    const sc = scanMbox(buf, atEnd);
    if (!sc.messages.length && sc.consumed === 0 && !atEnd) {
      // One message is bigger than the window: widen it, up to the size limit, then skip the message.
      if (window < maxWindow) {
        window = Math.min(window * 2, maxWindow);
        continue;
      }
      n.skipped++;
      skipping = true;
      window = baseWindow;
      if (!(await persist(false))) return;
      continue;
    }

    let stopAt = -1;
    for (const m of sc.messages) {
      if (handled > 0 && (clock() >= deadline || handled >= maxMessages)) {
        stopAt = m.sep;
        break;
      }
      handled++;
      if (m.end - m.start > LIMITS.maxMessageBytes) {
        n.skipped++;
        continue;
      }
      const sepLine = decoder.decode(buf.subarray(m.sep, Math.min(m.start, m.sep + 200)));
      let out: Outcome;
      try {
        out = await importOne(env, c, unescapeMboxrd(buf.subarray(m.start, m.end)), sepLine);
      } catch (e) {
        out = { kind: 'error', reason: (e as Error).name || 'store_failed' };
      }
      if (out.kind === 'imported') n.imported++;
      else if (out.kind === 'duplicate') n.duplicates++;
      else if (out.kind === 'skipped') n.skipped++;
      else if (out.kind === 'error') note(`byte ${cursor + m.sep}: ${out.reason}`);
    }
    cursor += stopAt >= 0 ? stopAt : sc.consumed;
    window = baseWindow;
    if (!(await persist(false))) return;
    if (stopAt >= 0) break;
  }

  if (cursor >= row.size) {
    const saved = await persist(false);
    if (saved) await finish(env, { ...row, errors_json: JSON.stringify(samples) }, 'done');
    return;
  }
  if (live) await persist(true);
}
