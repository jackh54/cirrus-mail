// email() handler: buffer → resolve → parse → store (R2) → thread → spam → filters → one D1 batch → forward/auto-reply.
import PostalMime, { type Email } from 'postal-mime';
import { LIMITS, type Address } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { dedupeAddresses, domainOf, fromParsed, normalizeEmail } from '../lib/addresses';
import { categorizeInbound } from '../lib/ai';
import { sha256Hex } from '../lib/crypto';
import { addressesForFts, folderIdsByRole, ftsInsertStmts, inlineBodyJson, recomputeThreadStmts } from '../lib/db';
import { htmlToText, makeSnippet } from '../lib/html';
import { storeAutocrypt } from '../lib/pgp-keyring';
import { mayStoreUnsub, parseListUnsubscribe } from '../lib/unsubscribe';
import { notifyNewMail } from '../push';
import { maybeAutoreply, type AutoreplyMailbox } from './autoreply';
import { evaluateFilters, rowToFilter, type FilterRow } from './filters';
import { resolveRecipient } from './resolve';
import { isBlocked, scoreSpam, spfPassesFor, toAuthResults, trustedAuthResults } from './spam';
import { findThread, normalizeSubject, parseMessageIds } from './thread';

export type InboundOutcome =
  | { accepted: false; reason: string }
  | { accepted: true; mailboxId: string; messageId: string | null; threadId: string | null; folderId: string | null; duplicate?: boolean };

async function logReceive(db: D1Database, mailboxId: string | null, accepted: boolean, reason: string | null, size: number) {
  await db.prepare('INSERT INTO receive_log (id, mailbox_id, accepted, reason, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ulid(), mailboxId, accepted ? 1 : 0, reason, size, Date.now()).run();
}

function headerGetter(email: Email) {
  return (name: string): string | null => email.headers.find((h) => h.key === name.toLowerCase())?.value ?? null;
}

export function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** The sender's Date, clamped to [received − 7 days, received + 5 minutes]; display only, never used for order. */
export function displayDate(value: string | undefined, now: number): number {
  const t = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return now;
  return Math.min(Math.max(t, now - 7 * 24 * 3600 * 1000), now + 5 * 60 * 1000);
}

/** Offset just past the first empty line: the body. Trace headers added on each delivery sit above it. */
function bodyOffset(raw: Uint8Array): number {
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] !== 10) continue;
    if (raw[i + 1] === 10) return i + 2;
    if (raw[i + 1] === 13 && raw[i + 2] === 10) return i + 3;
  }
  return raw.length;
}

/**
 * Identifies one message for duplicate suppression: its identifying headers, the auth verdict and the raw
 * body. A retry or a second delivery of the same message hashes the same; a different message that only
 * reuses the Message-ID (or an unauthenticated copy of an authenticated one) does not.
 */
export async function contentHash(raw: Uint8Array, fields: unknown[]): Promise<string> {
  const head = new TextEncoder().encode(JSON.stringify(fields) + '\n');
  const body = raw.subarray(bodyOffset(raw));
  const buf = new Uint8Array(head.byteLength + body.byteLength);
  buf.set(head, 0);
  buf.set(body, head.byteLength);
  return sha256Hex(buf);
}

/** `ctx`, when given, carries the new-mail push (waitUntil); without it no push is sent. */
export async function processInbound(message: ForwardableEmailMessage, env: Env, ctx?: ExecutionContext): Promise<InboundOutcome> {
  const db = env.DB;
  // 1. The raw stream is single-use: buffer it exactly once.
  if (message.rawSize > LIMITS.maxMessageBytes) {
    message.setReject('552 5.3.4 Message size exceeds fixed maximum message size');
    await logReceive(db, null, false, 'too_large', message.rawSize);
    return { accepted: false, reason: 'too_large' };
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const size = raw.byteLength;

  // 2. Resolve the envelope recipient.
  const rcpt = await resolveRecipient(db, message.to);
  if (!rcpt) {
    message.setReject('550 5.1.1 No such user');
    await logReceive(db, null, false, 'no_such_user', size);
    return { accepted: false, reason: 'no_such_user' };
  }
  const mailboxId = rcpt.mailboxId;

  // 3. Parse.
  let email: Email;
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  } catch {
    message.setReject('554 5.6.0 Malformed message');
    await logReceive(db, mailboxId, false, 'parse_error', size);
    return { accepted: false, reason: 'parse_error' };
  }
  const header = headerGetter(email);
  const now = Date.now();
  let msgIdHdr: string | null = parseMessageIds(email.messageId)[0] ?? null;

  const fromList = fromParsed(email.from);
  const from: Address = fromList[0] ?? { email: normalizeEmail(message.from) };
  const to = dedupeAddresses(fromParsed(email.to));
  const cc = dedupeAddresses(fromParsed(email.cc));
  const subject = (email.subject ?? '').slice(0, LIMITS.maxSubject);
  // Only Cloudflare's own (topmost) Authentication-Results counts; "aligned" ties a pass to the visible From.
  const parsedAuth = trustedAuthResults(email.headers.filter((h) => h.key === 'authentication-results').map((h) => h.value));
  const auth = toAuthResults(parsedAuth, domainOf(from.email));
  const hash = await contentHash(raw, [msgIdHdr, from.email, from.name ?? '', to.map((a) => a.email), cc.map((a) => a.email), subject, email.date ?? '', auth]);

  // The same message delivered twice (retries, alias + mailbox): keep the first copy. Only an identical copy
  // counts, so a planted message reusing the Message-ID cannot make us drop a genuine one. A copy whose
  // Message-ID collided with a sent one was stored with a NULL Message-ID; the hash (which covers the original
  // id) still finds it, through the same (mailbox_id, message_id_hdr) index.
  if (msgIdHdr) {
    const seen = await db.prepare(
      `SELECT COALESCE(
                (SELECT json_object('id', id, 'thread_id', thread_id, 'folder_id', folder_id) FROM messages
                  WHERE mailbox_id = ?1 AND message_id_hdr = ?2 AND direction = 'in' AND content_hash = ?3 LIMIT 1),
                (SELECT json_object('id', id, 'thread_id', thread_id, 'folder_id', folder_id) FROM messages
                  WHERE mailbox_id = ?1 AND message_id_hdr IS NULL AND direction = 'in' AND content_hash = ?3 LIMIT 1)) AS dup,
              EXISTS (SELECT 1 FROM messages WHERE mailbox_id = ?1 AND message_id_hdr = ?2 AND direction = 'out') AS sent`,
    ).bind(mailboxId, msgIdHdr, hash).first<{ dup: string | null; sent: number }>();
    if (seen?.dup) {
      const dup = JSON.parse(seen.dup) as { id: string; thread_id: string; folder_id: string };
      await logReceive(db, mailboxId, true, 'duplicate', size);
      return { accepted: true, mailboxId, messageId: dup.id, threadId: dup.thread_id, folderId: dup.folder_id, duplicate: true };
    }
    // An inbound copy may not take over the Message-ID of a message this mailbox sent (reply threading).
    if (seen?.sent) msgIdHdr = null;
  }

  const [mbRow, own, blockedRows, roles, filterRows] = await Promise.all([
    db.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(mailboxId).first<AutoreplyMailbox & { address: string }>(),
    db.prepare('SELECT address FROM mailboxes WHERE id = ?1 UNION SELECT address FROM aliases WHERE mailbox_id = ?1').bind(mailboxId).all<{ address: string }>(),
    db.prepare('SELECT pattern FROM blocked_senders WHERE mailbox_id = ?').bind(mailboxId).all<{ pattern: string }>(),
    folderIdsByRole(db, mailboxId),
    // creator_active: forward_to actions only run while their creator is an active member of the mailbox who is
    // still allowed to create them (a mailbox owner or an admin).
    db.prepare(
      `SELECT f.*, EXISTS (SELECT 1 FROM mailbox_members mm JOIN users u ON u.id = mm.user_id
                            WHERE mm.mailbox_id = f.mailbox_id AND mm.user_id = f.created_by AND u.disabled = 0
                              AND (mm.role = 'owner' OR u.role = 'admin')) AS creator_active
         FROM filters f WHERE f.mailbox_id = ? AND f.enabled = 1 ORDER BY f.sort`,
    ).bind(mailboxId).all<FilterRow & { creator_active: number }>(),
  ]);
  if (!mbRow || !roles.inbox) {
    message.setReject('550 5.1.1 No such user');
    await logReceive(db, null, false, 'no_such_user', size);
    return { accepted: false, reason: 'no_such_user' };
  }
  const ownAddresses = new Set(own.results.map((r) => r.address.toLowerCase()));

  const replyTo = email.replyTo?.length ? fromParsed(email.replyTo).map((a) => a.email).join(', ') : null;
  const text = email.text ?? (email.html ? htmlToText(email.html) : '');
  const html = email.html ?? null;
  const listId = header('list-id')?.slice(0, 300) ?? null;
  // Received time orders the thread; the sender's (clamped) Date is only displayed.
  const date = now;
  const shownDate = displayDate(email.date, now);

  // 6. Spam verdict.
  const sender = from.email.toLowerCase();
  const inContacts = !!(await db.prepare(
    'SELECT 1 FROM contacts c JOIN mailbox_members mm ON mm.user_id = c.user_id WHERE mm.mailbox_id = ? AND c.email = ? LIMIT 1',
  ).bind(mailboxId, sender).first());
  const blocked = isBlocked(sender, blockedRows.results.map((r) => r.pattern)) || isBlocked(normalizeEmail(message.from), blockedRows.results.map((r) => r.pattern));
  const spam = scoreSpam({ auth, blocked, inContacts });

  // 5. Threading.
  const subjectNorm = normalizeSubject(subject);
  const participants = [from, ...to, ...cc].map((a) => a.email.toLowerCase());
  const references = parseMessageIds(email.references);
  const inReplyTo = parseMessageIds(email.inReplyTo);
  const existingThread = await findThread(db, { mailboxId, inReplyTo, references, subjectNorm, participants, ownAddresses, now });

  // A muted thread's new mail skips the Inbox; a snoozed one is brought back by a reply.
  const threadFlags = existingThread
    ? await db.prepare('SELECT muted, snoozed_until FROM threads WHERE id = ? AND mailbox_id = ?').bind(existingThread, mailboxId).first<{ muted: number; snoozed_until: number | null }>()
    : null;
  // One-click unsubscribe data is only trusted from authenticated senders.
  const unsub = mayStoreUnsub(auth) ? parseListUnsubscribe(header('list-unsubscribe'), header('list-unsubscribe-post')) : null;

  // 7. Filters (skipped for spam so a rule cannot pull spam back into the inbox).
  const attachmentsAll = email.attachments.slice(0, 100);
  const isInlinePart = (a: (typeof attachmentsAll)[number]) => !!a.contentId && (a.disposition === 'inline' || !!a.related);
  const hasAttachments = attachmentsAll.some((a) => !isInlinePart(a));
  let folderId = spam.isSpam ? roles.spam : roles.inbox;
  let isRead = 0;
  let isStarred = 0;
  let forwards: string[] = [];
  let labelIds: string[] = [];
  if (!spam.isSpam && filterRows.results.length) {
    const rules = filterRows.results.map((r) => {
      const f = rowToFilter(r);
      return r.creator_active ? f : { ...f, actions: f.actions.filter((a) => a.type !== 'forward_to') };
    });
    const outcome = evaluateFilters(rules, {
      from, to: [...to, ...cc].map((a) => a.email).concat(normalizeEmail(message.to)), subject, hasAttachment: hasAttachments, listId,
    });
    if (outcome.folderId) {
      const ok = await db.prepare("SELECT id FROM folders WHERE id = ? AND mailbox_id = ? AND (role IS NULL OR role IN ('inbox','archive','spam','trash'))")
        .bind(outcome.folderId, mailboxId).first<string>('id');
      if (ok) folderId = ok;
    }
    if (outcome.trash) folderId = roles.trash;
    if (outcome.markRead) isRead = 1;
    if (outcome.star) isStarred = 1;
    forwards = outcome.forwards;
    labelIds = outcome.labelIds.slice(0, 10);
  }

  if (threadFlags?.muted && folderId === roles.inbox) {
    folderId = roles.archive;
    isRead = 1;
  }

  // 4. Store raw, body and attachments in R2.
  const id = ulid(now);
  const threadId = existingThread ?? ulid(now);
  const rawKey = `raw/${mailboxId}/${id}.eml`;
  const bodyKey = `body/${mailboxId}/${id}.json`;
  const atts = attachmentsAll.map((a) => {
    const aid = ulid(now);
    const bytes = toBytes(a.content);
    return {
      id: aid, bytes, key: `att/${mailboxId}/${aid}`,
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

  // 8. One atomic batch: thread, message, attachments, FTS, aggregates, receive_log.
  const stmts: D1PreparedStatement[] = [];
  if (!existingThread) {
    stmts.push(db.prepare('INSERT INTO threads (id, mailbox_id, subject, subject_norm, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(threadId, mailboxId, subject, subjectNorm, date, now));
  }
  stmts.push(db.prepare(
    `INSERT INTO messages (id, mailbox_id, thread_id, folder_id, direction, status, message_id_hdr, in_reply_to, references_hdr,
       from_email, from_name, to_json, cc_json, bcc_json, reply_to, subject, snippet, body_key, body_inline, raw_key, size, has_attachments,
       is_read, is_starred, spam_score, auth_json, list_id, date, display_date, content_hash, created_at, updated_at, folder_changed_at, unsub_json)
     VALUES (?, ?, ?, ?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, mailboxId, threadId, folderId, msgIdHdr, inReplyTo[0] ?? null, references.length ? references.join(' ').slice(0, 8000) : null,
    from.email, from.name ?? '', JSON.stringify(to), JSON.stringify(cc), replyTo, subject, makeSnippet(text), bodyKey, inlineBodyJson(html, text), rawKey, size,
    hasAttachments ? 1 : 0, isRead, isStarred, spam.score, auth ? JSON.stringify(auth) : null, listId, date, shownDate, hash, now, now, now,
    unsub ? JSON.stringify(unsub) : null));
  for (const a of atts) {
    stmts.push(db.prepare('INSERT INTO attachments (id, message_id, mailbox_id, filename, mime_type, size, content_id, inline, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(a.id, id, mailboxId, a.filename, a.mime, a.bytes.byteLength, a.contentId, a.inline, a.key, now));
  }
  // A label that was deleted since the filter was saved matches no row, so the insert is skipped.
  for (const labelId of labelIds) {
    stmts.push(db.prepare('INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?, id FROM labels WHERE id = ? AND mailbox_id = ?').bind(id, labelId, mailboxId));
  }
  stmts.push(...ftsInsertStmts(db, { id, mailboxId, subject, addresses: addressesForFts(from, to, cc), body: text }));
  if (threadFlags?.snoozed_until && folderId === roles.inbox) {
    stmts.push(db.prepare('UPDATE threads SET snoozed_until = NULL WHERE id = ?').bind(threadId));
  }
  stmts.push(...recomputeThreadStmts(db, threadId));
  stmts.push(db.prepare('INSERT INTO receive_log (id, mailbox_id, accepted, reason, size, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .bind(ulid(now), mailboxId, spam.isSpam ? 'spam' : null, size, now));
  try {
    await db.batch(stmts);
  } catch (e) {
    await env.BUCKET.delete(r2Keys).catch(() => undefined);
    throw e;
  }

  // Autocrypt: remember the sender's key for the mailbox's members (aligned DMARC only; never throws).
  if (!spam.isSpam) {
    await storeAutocrypt(db, mailboxId, from.email, email.headers.filter((h) => h.key === 'autocrypt').map((h) => h.value), auth);
  }

  // Web Push for unread mail stored in the Inbox (not spam, trash, another folder, or filtered to read).
  // Off the delivery path: notifyNewMail never throws and the email handler does not wait for it.
  if (ctx && !spam.isSpam && folderId === roles.inbox && !isRead) {
    ctx.waitUntil(notifyNewMail(env, { mailboxId, mailboxAddress: mbRow.address, threadId, from, subject }, now));
  }

  // Inbox category (optional AI triage): after the message is stored, off the delivery path. It does nothing unless
  // an admin has enabled the feature, and never throws.
  if (ctx && !spam.isSpam && folderId === roles.inbox) {
    ctx.waitUntil(categorizeInbound(env, { mailboxId, threadId, fromEmail: from.email, fromName: from.name, subject, text, header }, now));
  }

  // Filter forwards: must be verified Email Routing destinations; failures are logged, not fatal.
  for (const addr of forwards) {
    try {
      await message.forward(addr);
    } catch (e) {
      console.error('filter forward failed', String((e as { code?: unknown }).code ?? (e as Error).name));
    }
  }

  // 9. Vacation auto-reply.
  if (!spam.isSpam && folderId !== roles.trash) {
    try {
      await maybeAutoreply(env, mbRow, {
        sender: normalizeEmail(message.from), fromDomain: domainOf(from.email), envelopeSpfPass: spfPassesFor(parsedAuth, domainOf(normalizeEmail(message.from))),
        subject, messageId: msgIdHdr, headers: header, auth, ownAddresses, now,
      });
    } catch (e) {
      console.error('autoreply error', (e as Error).name);
    }
  }
  return { accepted: true, mailboxId, messageId: id, threadId, folderId };
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  await processInbound(message, env, ctx);
}
