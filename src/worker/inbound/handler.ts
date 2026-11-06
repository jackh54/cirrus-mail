// email() handler: buffer → resolve → parse → store (R2) → thread → spam → filters → one D1 batch → forward/auto-reply.
import PostalMime, { type Email } from 'postal-mime';
import { LIMITS, type Address } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { dedupeAddresses, fromParsed, normalizeEmail } from '../lib/addresses';
import { addressesForFts, folderIdsByRole, ftsInsertStmt, recomputeThreadStmts } from '../lib/db';
import { htmlToText, makeSnippet } from '../lib/html';
import { maybeAutoreply, type AutoreplyMailbox } from './autoreply';
import { evaluateFilters, rowToFilter, type FilterRow } from './filters';
import { resolveRecipient } from './resolve';
import { isBlocked, parseAuthResults, scoreSpam } from './spam';
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

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function parseDate(value: string | undefined, now: number): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t > 0 && t < now + 24 * 3600 * 1000 ? t : now;
}

export async function processInbound(message: ForwardableEmailMessage, env: Env): Promise<InboundOutcome> {
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
  const msgIdHdr = parseMessageIds(email.messageId)[0] ?? null;

  // Same Message-ID delivered twice (retries, alias + mailbox): keep the first copy.
  if (msgIdHdr) {
    const dup = await db.prepare("SELECT id, thread_id, folder_id FROM messages WHERE mailbox_id = ? AND message_id_hdr = ? AND direction = 'in'")
      .bind(mailboxId, msgIdHdr).first<{ id: string; thread_id: string; folder_id: string }>();
    if (dup) {
      await logReceive(db, mailboxId, true, 'duplicate', size);
      return { accepted: true, mailboxId, messageId: dup.id, threadId: dup.thread_id, folderId: dup.folder_id, duplicate: true };
    }
  }

  const [mbRow, own, blockedRows, roles, filterRows] = await Promise.all([
    db.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(mailboxId).first<AutoreplyMailbox & { address: string }>(),
    db.prepare('SELECT address FROM mailboxes WHERE id = ?1 UNION SELECT address FROM aliases WHERE mailbox_id = ?1').bind(mailboxId).all<{ address: string }>(),
    db.prepare('SELECT pattern FROM blocked_senders WHERE mailbox_id = ?').bind(mailboxId).all<{ pattern: string }>(),
    folderIdsByRole(db, mailboxId),
    db.prepare('SELECT * FROM filters WHERE mailbox_id = ? AND enabled = 1 ORDER BY sort').bind(mailboxId).all<FilterRow>(),
  ]);
  if (!mbRow || !roles.inbox) {
    message.setReject('550 5.1.1 No such user');
    await logReceive(db, null, false, 'no_such_user', size);
    return { accepted: false, reason: 'no_such_user' };
  }
  const ownAddresses = new Set(own.results.map((r) => r.address.toLowerCase()));

  const fromList = fromParsed(email.from);
  const from: Address = fromList[0] ?? { email: normalizeEmail(message.from) };
  const to = dedupeAddresses(fromParsed(email.to));
  const cc = dedupeAddresses(fromParsed(email.cc));
  const replyTo = email.replyTo?.length ? fromParsed(email.replyTo).map((a) => a.email).join(', ') : null;
  const subject = (email.subject ?? '').slice(0, LIMITS.maxSubject);
  const text = email.text ?? (email.html ? htmlToText(email.html) : '');
  const html = email.html ?? null;
  const listId = header('list-id')?.slice(0, 300) ?? null;
  const auth = parseAuthResults(header('authentication-results'));
  const date = parseDate(email.date, now);

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

  // 7. Filters (skipped for spam so a rule cannot pull spam back into the inbox).
  const attachmentsAll = email.attachments.slice(0, 100);
  const isInlinePart = (a: (typeof attachmentsAll)[number]) => !!a.contentId && (a.disposition === 'inline' || !!a.related);
  const hasAttachments = attachmentsAll.some((a) => !isInlinePart(a));
  let folderId = spam.isSpam ? roles.spam : roles.inbox;
  let isRead = 0;
  let isStarred = 0;
  let forwards: string[] = [];
  if (!spam.isSpam && filterRows.results.length) {
    const outcome = evaluateFilters(filterRows.results.map(rowToFilter), {
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
       from_email, from_name, to_json, cc_json, bcc_json, reply_to, subject, snippet, body_key, raw_key, size, has_attachments,
       is_read, is_starred, spam_score, auth_json, list_id, date, created_at, updated_at, folder_changed_at)
     VALUES (?, ?, ?, ?, 'in', 'received', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, mailboxId, threadId, folderId, msgIdHdr, inReplyTo[0] ?? null, references.length ? references.join(' ').slice(0, 8000) : null,
    from.email, from.name ?? '', JSON.stringify(to), JSON.stringify(cc), replyTo, subject, makeSnippet(text), bodyKey, rawKey, size,
    hasAttachments ? 1 : 0, isRead, isStarred, spam.score, auth ? JSON.stringify(auth) : null, listId, date, now, now, now));
  for (const a of atts) {
    stmts.push(db.prepare('INSERT INTO attachments (id, message_id, mailbox_id, filename, mime_type, size, content_id, inline, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(a.id, id, mailboxId, a.filename, a.mime, a.bytes.byteLength, a.contentId, a.inline, a.key, now));
  }
  stmts.push(ftsInsertStmt(db, { id, mailboxId, subject, addresses: addressesForFts(from, to, cc), body: text }));
  stmts.push(...recomputeThreadStmts(db, threadId));
  stmts.push(db.prepare('INSERT INTO receive_log (id, mailbox_id, accepted, reason, size, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .bind(ulid(now), mailboxId, spam.isSpam ? 'spam' : null, size, now));
  try {
    await db.batch(stmts);
  } catch (e) {
    await env.BUCKET.delete(r2Keys).catch(() => undefined);
    throw e;
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
        sender: normalizeEmail(message.from), subject, messageId: msgIdHdr, headers: header, auth, ownAddresses, now,
      });
    } catch (e) {
      console.error('autoreply error', (e as Error).name);
    }
  }
  return { accepted: true, mailboxId, messageId: id, threadId, folderId };
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
  await processInbound(message, env);
}
