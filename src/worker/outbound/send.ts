// Outbound: identity checks, recipient/size validation, env.EMAIL.send(), status bookkeeping.
import { LIMITS, type Address } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { parseJsonAddresses } from '../lib/addresses';
import { folderIdsByRole, loadBody, recomputeThreadStmts, type AttachmentRow, type MessageRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import { cleanHeaderText } from '../lib/validate';
import { htmlToText } from '../lib/html';
import { recordSendsSafe } from '../lib/sendcount';

const QUOTA_CODES = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED']);

/** Fixed, user-facing messages. The provider's raw error text is never stored or returned. */
const SEND_ERROR_MESSAGES: Record<string, string> = {
  E_VALIDATION_ERROR: 'The message was rejected as invalid.',
  E_FIELD_MISSING: 'The message is missing a required field.',
  E_TOO_MANY_RECIPIENTS: `Too many recipients (the limit is ${LIMITS.maxRecipients}).`,
  E_SENDER_NOT_VERIFIED: 'This From address is not verified for Email Sending.',
  E_RECIPIENT_NOT_ALLOWED: 'One or more recipients are not allowed.',
  E_RECIPIENT_SUPPRESSED: 'One or more recipients are on the suppression list.',
  E_CONTENT_TOO_LARGE: 'The message is larger than 25 MiB.',
  E_DELIVERY_FAILED: 'Delivery failed. Try again later.',
  E_RATE_LIMIT_EXCEEDED: 'You are sending too fast. Wait a minute and try again.',
  E_DAILY_LIMIT_EXCEEDED: 'The daily sending limit for this account has been reached. Try again tomorrow.',
  E_ATTACHMENT_MISSING: 'An attachment is missing from storage. Remove it and try again.',
  IDENTITY_NOT_ALLOWED: 'This mailbox can no longer send from that address, so the scheduled message was not sent.',
};

/** Normalises a thrown send error to a known code and a fixed message. */
export function mapSendError(e: unknown): { code: string; message: string } {
  const raw = (e as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' && /^E_[A-Z_]{1,48}$/.test(raw) ? raw : 'E_DELIVERY_FAILED';
  if (SEND_ERROR_MESSAGES[code]) return { code, message: SEND_ERROR_MESSAGES[code] };
  if (code.startsWith('E_HEADER_')) return { code, message: 'A message header was rejected by the sending service.' };
  return { code, message: 'Sending failed. Try again later.' };
}

export function sendErrorMessage(code: string): string {
  return SEND_ERROR_MESSAGES[code] ?? 'Sending failed. Try again later.';
}

export type SendResult = { ok: true; messageId: string } | { ok: false; code: string; message: string };

/** Message-IDs are stored with angle brackets so they match what replies put in In-Reply-To. */
export function bracketId(id: string): string {
  const t = id.trim();
  return t.startsWith('<') ? t : `<${t}>`;
}

export function sendErrorStatus(code: string): 429 | 502 {
  return QUOTA_CODES.has(code) ? 429 : 502;
}

/** Addresses this mailbox may send as: its own address plus aliases with can_send. */
export async function sendableAddresses(db: D1Database, mailboxId: string): Promise<Set<string>> {
  const [mb, al] = await db.batch([
    db.prepare('SELECT address FROM mailboxes WHERE id = ?').bind(mailboxId),
    db.prepare('SELECT address FROM aliases WHERE mailbox_id = ? AND can_send = 1').bind(mailboxId),
  ]);
  return new Set([...(mb.results as { address: string }[]), ...(al.results as { address: string }[])].map((r) => r.address.toLowerCase()));
}

export interface DraftCheck { recipients: number; size: number }

/** Validates a draft before it is sent or scheduled. Throws HttpError on problems. */
export async function validateDraft(db: D1Database, row: MessageRow): Promise<DraftCheck> {
  const allowed = await sendableAddresses(db, row.mailbox_id);
  if (!allowed.has(row.from_email.toLowerCase())) throw new HttpError(403, 'INVALID_FROM', 'You cannot send from that address');
  const recipients = parseJsonAddresses(row.to_json).length + parseJsonAddresses(row.cc_json).length + parseJsonAddresses(row.bcc_json).length;
  if (recipients === 0) throw new HttpError(400, 'NO_RECIPIENTS', 'Add at least one recipient');
  if (recipients > LIMITS.maxRecipients) throw new HttpError(400, 'TOO_MANY_RECIPIENTS', `At most ${LIMITS.maxRecipients} recipients per message`);
  const att = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE message_id = ?').bind(row.id).first<{ n: number; bytes: number }>();
  if ((att?.n ?? 0) > LIMITS.maxAttachments) throw new HttpError(400, 'TOO_MANY_ATTACHMENTS', `At most ${LIMITS.maxAttachments} attachments`);
  if (row.size > LIMITS.maxMessageBytes) throw new HttpError(400, 'MESSAGE_TOO_LARGE', 'Message exceeds 25 MiB');
  return { recipients, size: row.size };
}

function toBuilderAddr(a: Address): string | EmailAddress {
  const name = a.name ? cleanHeaderText(a.name).trim() : '';
  return name ? { email: a.email, name } : a.email;
}

/**
 * Sends a message row that has already been claimed (status 'sending'). Updates the row to
 * 'sent' (moved to Sent) or 'failed' (moved back to Drafts), writes send_log and contacts.
 */
export async function performSend(env: Env, row: MessageRow, contactUserIds: string[]): Promise<SendResult> {
  const db = env.DB;
  const to = parseJsonAddresses(row.to_json);
  const cc = parseJsonAddresses(row.cc_json);
  const bcc = parseJsonAddresses(row.bcc_json);
  let result: SendResult;
  try {
    const body = await loadBody(env, row.body_key);
    const { results: atts } = await db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, id').bind(row.id).all<AttachmentRow>();
    const attachments: EmailAttachment[] = [];
    for (const a of atts) {
      const obj = await env.BUCKET.get(a.r2_key);
      if (!obj) throw Object.assign(new Error('Attachment is missing from storage'), { code: 'E_ATTACHMENT_MISSING' });
      attachments.push({ content: await obj.arrayBuffer(), filename: cleanHeaderText(a.filename), type: cleanHeaderText(a.mime_type), disposition: 'attachment' });
    }
    // Every header-bound value is re-sanitised here, whatever was stored earlier.
    const headers: Record<string, string> = {};
    if (row.in_reply_to) headers['In-Reply-To'] = cleanHeaderText(row.in_reply_to);
    if (row.references_hdr) headers['References'] = cleanHeaderText(row.references_hdr);
    const fromName = cleanHeaderText(row.from_name).trim();
    const builder = {
      from: fromName ? { email: row.from_email, name: fromName } : row.from_email,
      ...(to.length ? { to: to.map(toBuilderAddr) } : {}),
      ...(cc.length ? { cc: cc.map(toBuilderAddr) } : {}),
      ...(bcc.length ? { bcc: bcc.map(toBuilderAddr) } : {}),
      subject: cleanHeaderText(row.subject),
      ...(body.html ? { html: body.html } : {}),
      text: body.text || (body.html ? htmlToText(body.html) : ''),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(attachments.length ? { attachments } : {}),
    } as EmailMessageBuilder;
    const res = await env.EMAIL.send(builder);
    result = { ok: true, messageId: bracketId(res.messageId) };
    // Once per claimed send (claimForSend lets only one attempt through), one per recipient.
    await recordSendsSafe(db, to.length + cc.length + bcc.length);
  } catch (e) {
    const { code, message } = mapSendError(e);
    console.error('send failed', code);
    result = { ok: false, code, message };
  }
  await recordOutcome(env, row, result, contactUserIds);
  return result;
}

/** Writes the result of a send attempt: row status/folder, contacts, send_log, thread aggregates. */
export async function recordOutcome(env: Env, row: MessageRow, result: SendResult, contactUserIds: string[]): Promise<void> {
  const db = env.DB;
  const roles = await folderIdsByRole(db, row.mailbox_id);
  const to = parseJsonAddresses(row.to_json);
  const cc = parseJsonAddresses(row.cc_json);
  const bcc = parseJsonAddresses(row.bcc_json);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (result.ok) {
    stmts.push(db.prepare(
      `UPDATE messages SET status = 'sent', message_id_hdr = ?, sent_at = ?, date = ?, send_at = NULL, folder_id = ?,
              folder_changed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL, is_read = 1 WHERE id = ?`,
    ).bind(result.messageId, now, now, roles.sent, now, now, row.id));
    for (const uid of contactUserIds) {
      for (const a of [...to, ...cc, ...bcc]) {
        stmts.push(db.prepare(
          `INSERT INTO contacts (id, user_id, email, name, times_used, last_used_at) VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(user_id, email) DO UPDATE SET times_used = times_used + 1, last_used_at = excluded.last_used_at,
             name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END`,
        ).bind(ulid(now), uid, a.email.toLowerCase(), a.name ?? '', now));
      }
    }
  } else {
    stmts.push(db.prepare(
      `UPDATE messages SET status = 'failed', error_code = ?, error_message = ?, send_at = NULL, folder_id = ?,
              folder_changed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(result.code, result.message, roles.drafts, now, now, row.id));
  }
  stmts.push(db.prepare('INSERT INTO send_log (id, mailbox_id, message_id, recipients, ok, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(ulid(now), row.mailbox_id, row.id, to.length + cc.length + bcc.length, result.ok ? 1 : 0, result.ok ? null : result.code, now));
  stmts.push(...recomputeThreadStmts(db, row.thread_id));
  await db.batch(stmts);
}

/**
 * Atomically claims a draft/failed/scheduled row for sending and returns the row as it is at that moment
 * (null when it was not claimable). Send only from this returned row: recipients, subject and body key then
 * come from one snapshot, and a 'sending' row can no longer be edited, cancelled or rescheduled.
 * With `dueBy`, the row's send_at must also still be at or before it (scheduled sends).
 */
export async function claimForSend(db: D1Database, id: string, from: ('draft' | 'failed' | 'scheduled')[], dueBy?: number): Promise<MessageRow | null> {
  const ph = from.map(() => '?').join(',');
  const due = dueBy === undefined ? '' : ' AND send_at <= ?';
  return db.prepare(`UPDATE messages SET status = 'sending', updated_at = ? WHERE id = ? AND status IN (${ph})${due} RETURNING *`)
    .bind(Date.now(), id, ...from, ...(dueBy === undefined ? [] : [dueBy])).first<MessageRow>();
}

/** Contacts are collected for the sending user, or for every member when the cron sends. */
export async function mailboxMemberIds(db: D1Database, mailboxId: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT user_id FROM mailbox_members WHERE mailbox_id = ?').bind(mailboxId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/**
 * Re-checks a claimed scheduled message right before the cron sends it: the From identity must still
 * belong to the mailbox, and whoever scheduled it must still be an active member (a NULL scheduled_by fails).
 * Returns null when it may be sent, otherwise the failure to record.
 */
export async function checkScheduled(db: D1Database, row: MessageRow): Promise<{ code: string; message: string } | null> {
  // Rows scheduled before scheduled_by existed have no one to vouch for them: fail closed.
  const member = row.scheduled_by
    ? await db.prepare('SELECT 1 FROM mailbox_members mm JOIN users u ON u.id = mm.user_id WHERE mm.mailbox_id = ? AND mm.user_id = ? AND u.disabled = 0')
        .bind(row.mailbox_id, row.scheduled_by).first()
    : null;
  if (!member) return { code: 'IDENTITY_NOT_ALLOWED', message: sendErrorMessage('IDENTITY_NOT_ALLOWED') };
  try {
    await validateDraft(db, row);
  } catch (e) {
    if (e instanceof HttpError && e.code !== 'INVALID_FROM') return { code: e.code, message: e.message };
    return { code: 'IDENTITY_NOT_ALLOWED', message: sendErrorMessage('IDENTITY_NOT_ALLOWED') };
  }
  return null;
}
