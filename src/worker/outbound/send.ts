// Outbound: identity checks, recipient/size validation, env.EMAIL.send(), status bookkeeping.
import { LIMITS, type Address } from '../../shared/api';
import { ulid } from '../../shared/ulid';
import { parseJsonAddresses } from '../lib/addresses';
import { folderIdsByRole, loadBody, recomputeThreadStmts, type AttachmentRow, type MessageRow } from '../lib/db';
import { HttpError } from '../lib/errors';
import { htmlToText } from '../lib/html';

const QUOTA_CODES = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED']);

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
  return a.name ? { email: a.email, name: a.name } : a.email;
}

/**
 * Sends a message row that has already been claimed (status 'sending'). Updates the row to
 * 'sent' (moved to Sent) or 'failed' (moved back to Drafts), writes send_log and contacts.
 */
export async function performSend(env: Env, row: MessageRow, contactUserIds: string[]): Promise<SendResult> {
  const db = env.DB;
  const roles = await folderIdsByRole(db, row.mailbox_id);
  const to = parseJsonAddresses(row.to_json);
  const cc = parseJsonAddresses(row.cc_json);
  const bcc = parseJsonAddresses(row.bcc_json);
  const now = Date.now();
  let result: SendResult;
  try {
    const body = await loadBody(env, row.body_key);
    const { results: atts } = await db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, id').bind(row.id).all<AttachmentRow>();
    const attachments: EmailAttachment[] = [];
    for (const a of atts) {
      const obj = await env.BUCKET.get(a.r2_key);
      if (!obj) throw Object.assign(new Error('Attachment is missing from storage'), { code: 'E_ATTACHMENT_MISSING' });
      attachments.push({ content: await obj.arrayBuffer(), filename: a.filename, type: a.mime_type, disposition: 'attachment' });
    }
    const headers: Record<string, string> = {};
    if (row.in_reply_to) headers['In-Reply-To'] = row.in_reply_to;
    if (row.references_hdr) headers['References'] = row.references_hdr;
    const builder = {
      from: row.from_name ? { email: row.from_email, name: row.from_name } : row.from_email,
      ...(to.length ? { to: to.map(toBuilderAddr) } : {}),
      ...(cc.length ? { cc: cc.map(toBuilderAddr) } : {}),
      ...(bcc.length ? { bcc: bcc.map(toBuilderAddr) } : {}),
      subject: row.subject,
      ...(body.html ? { html: body.html } : {}),
      text: body.text || (body.html ? htmlToText(body.html) : ''),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(attachments.length ? { attachments } : {}),
    } as EmailMessageBuilder;
    const res = await env.EMAIL.send(builder);
    result = { ok: true, messageId: bracketId(res.messageId) };
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    const code = typeof err.code === 'string' && err.code ? err.code : 'E_DELIVERY_FAILED';
    const message = (typeof err.message === 'string' && err.message ? err.message : 'Sending failed').slice(0, 500);
    console.error('send failed', code);
    result = { ok: false, code, message };
  }
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
  return result;
}

/** Atomically claims a draft/failed/scheduled row for sending. */
export async function claimForSend(db: D1Database, id: string, from: ('draft' | 'failed' | 'scheduled')[]): Promise<boolean> {
  const ph = from.map(() => '?').join(',');
  const res = await db.prepare(`UPDATE messages SET status = 'sending', updated_at = ? WHERE id = ? AND status IN (${ph})`).bind(Date.now(), id, ...from).run();
  return res.meta.changes === 1;
}

/** Contacts are collected for the sending user, or for every member when the cron sends. */
export async function mailboxMemberIds(db: D1Database, mailboxId: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT user_id FROM mailbox_members WHERE mailbox_id = ?').bind(mailboxId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}
