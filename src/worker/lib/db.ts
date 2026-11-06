// Row types, mappers and shared D1 helpers.
import type { Address, Attachment, AuthResults, FolderRole, MessageFull, ThreadSummary, User } from '../../shared/api';
import { parseJsonAddresses } from './addresses';
import { signFileUrl } from './sign';

export interface UserRow {
  id: string; email: string; name: string; password_hash: string; role: 'admin' | 'member';
  totp_secret: string | null; totp_pending: string | null; theme: User['theme']; density: User['density'];
  disabled: number; must_change_password: number; created_at: number; updated_at: number;
}

export interface MessageRow {
  id: string; mailbox_id: string; thread_id: string; folder_id: string; direction: 'in' | 'out';
  status: MessageFull['status']; message_id_hdr: string | null; in_reply_to: string | null; references_hdr: string | null;
  parent_id: string | null; compose_mode: MessageFull['composeMode']; from_email: string; from_name: string;
  to_json: string; cc_json: string; bcc_json: string; reply_to: string | null; subject: string; snippet: string;
  body_key: string | null; raw_key: string | null; size: number; has_attachments: number; is_read: number;
  is_starred: number; spam_score: number; auth_json: string | null; list_id: string | null; send_at: number | null;
  sent_at: number | null; error_code: string | null; error_message: string | null; date: number;
  created_at: number; updated_at: number; folder_changed_at: number;
}

export interface AttachmentRow {
  id: string; message_id: string; mailbox_id: string; filename: string; mime_type: string; size: number;
  content_id: string | null; inline: number; r2_key: string; created_at: number;
}

export interface ThreadRow {
  id: string; mailbox_id: string; subject: string; subject_norm: string; snippet: string; participants: string;
  message_count: number; unread_count: number; has_attachments: number; is_starred: number;
  last_message_at: number; created_at: number;
}

export interface StoredBody { html: string | null; text: string | null }

export const SYSTEM_FOLDERS: { role: FolderRole; name: string }[] = [
  { role: 'inbox', name: 'Inbox' },
  { role: 'sent', name: 'Sent' },
  { role: 'drafts', name: 'Drafts' },
  { role: 'scheduled', name: 'Scheduled' },
  { role: 'archive', name: 'Archive' },
  { role: 'spam', name: 'Spam' },
  { role: 'trash', name: 'Trash' },
];

export function rowToUser(r: UserRow): User {
  return {
    id: r.id, email: r.email, name: r.name, role: r.role, totpEnabled: !!r.totp_secret,
    theme: r.theme, density: r.density, mustChangePassword: !!r.must_change_password, createdAt: r.created_at,
  };
}

export async function folderIdsByRole(db: D1Database, mailboxId: string): Promise<Record<FolderRole, string>> {
  const { results } = await db.prepare('SELECT id, role FROM folders WHERE mailbox_id = ? AND role IS NOT NULL').bind(mailboxId).all<{ id: string; role: FolderRole }>();
  const out = {} as Record<FolderRole, string>;
  for (const r of results) out[r.role] = r.id;
  return out;
}

/**
 * Statements that rebuild a thread's aggregates from its messages (and delete it when empty).
 * "Visible" messages are received or sent ones; drafts/scheduled/failed only count when the thread has nothing else.
 */
export function recomputeThreadStmts(db: D1Database, threadId: string): D1PreparedStatement[] {
  const VIS = "status IN ('received','sent')";
  const anyVis = `EXISTS (SELECT 1 FROM messages WHERE thread_id = ?1 AND ${VIS})`;
  const scope = `thread_id = ?1 AND (${VIS} OR NOT ${anyVis})`;
  return [
    db.prepare(`UPDATE threads SET
        message_count   = (SELECT COUNT(*) FROM messages WHERE ${scope}),
        unread_count    = (SELECT COUNT(*) FROM messages WHERE ${scope} AND is_read = 0),
        has_attachments = EXISTS (SELECT 1 FROM messages WHERE ${scope} AND has_attachments = 1),
        is_starred      = EXISTS (SELECT 1 FROM messages WHERE thread_id = ?1 AND is_starred = 1),
        last_message_at = COALESCE((SELECT MAX(date) FROM messages WHERE ${scope}), last_message_at),
        snippet         = COALESCE((SELECT snippet FROM messages WHERE ${scope} ORDER BY date DESC LIMIT 1), snippet),
        subject         = COALESCE((SELECT subject FROM messages WHERE ${scope} ORDER BY date ASC LIMIT 1), subject),
        participants    = COALESCE((SELECT json_group_array(json_object('name', n, 'email', e)) FROM (
                            SELECT lower(from_email) AS e, MAX(from_name) AS n, MIN(date) AS d FROM messages
                            WHERE ${scope} AND from_email != '' GROUP BY lower(from_email) ORDER BY d LIMIT 10)), '[]')
      WHERE id = ?1`).bind(threadId),
    db.prepare('DELETE FROM threads WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = ?1)').bind(threadId),
  ];
}

export async function recomputeThreads(db: D1Database, threadIds: Iterable<string>): Promise<void> {
  const stmts = [...new Set(threadIds)].flatMap((t) => recomputeThreadStmts(db, t));
  if (stmts.length) await db.batch(stmts);
}

export function threadRowToSummary(t: ThreadRow, folderIds: string[], lastMessageAt?: number): ThreadSummary {
  let participants: Address[] = [];
  try {
    participants = (JSON.parse(t.participants) as Address[]).map((p) => (p.name ? p : { email: p.email }));
  } catch { /* keep empty */ }
  return {
    id: t.id, subject: t.subject, snippet: t.snippet, participants, messageCount: t.message_count,
    unreadCount: t.unread_count, hasAttachments: !!t.has_attachments, isStarred: !!t.is_starred,
    lastMessageAt: lastMessageAt ?? t.last_message_at, folderIds,
  };
}

/** Loads summaries (with folderIds) for the given thread ids, preserving order. */
export async function loadSummaries(db: D1Database, mailboxId: string, ids: string[], keys?: Map<string, number>): Promise<ThreadSummary[]> {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const [threads, folders] = await db.batch([
    db.prepare(`SELECT * FROM threads WHERE mailbox_id = ? AND id IN (${ph})`).bind(mailboxId, ...ids),
    db.prepare(`SELECT DISTINCT thread_id, folder_id FROM messages WHERE mailbox_id = ? AND thread_id IN (${ph})`).bind(mailboxId, ...ids),
  ]);
  const fmap = new Map<string, string[]>();
  for (const r of folders.results as { thread_id: string; folder_id: string }[]) {
    const list = fmap.get(r.thread_id) ?? [];
    list.push(r.folder_id);
    fmap.set(r.thread_id, list);
  }
  const tmap = new Map((threads.results as unknown as ThreadRow[]).map((t) => [t.id, t]));
  return ids.filter((id) => tmap.has(id)).map((id) => threadRowToSummary(tmap.get(id)!, fmap.get(id) ?? [], keys?.get(id)));
}

export async function loadBody(env: Env, key: string | null): Promise<StoredBody> {
  if (!key) return { html: null, text: null };
  const obj = await env.BUCKET.get(key);
  if (!obj) return { html: null, text: null };
  try {
    return await obj.json<StoredBody>();
  } catch {
    return { html: null, text: null };
  }
}

export async function attachmentToApi(env: Env, origin: string, a: AttachmentRow): Promise<Attachment> {
  return {
    id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size, contentId: a.content_id,
    inline: !!a.inline, url: await signFileUrl(env, origin, a.id, a.inline === 1 || a.mime_type.startsWith('image/')),
  };
}

/** Replaces `cid:` references with signed attachment URLs. */
export function rewriteCids(html: string, atts: Attachment[]): string {
  const byCid = new Map<string, string>();
  for (const a of atts) if (a.contentId) byCid.set(a.contentId.toLowerCase(), a.url);
  if (!byCid.size) return html;
  return html.replace(/cid:([^"'\s)>]+)/gi, (m, cid: string) => {
    let key = cid;
    try { key = decodeURIComponent(cid); } catch { /* raw */ }
    return byCid.get(key.toLowerCase()) ?? m;
  });
}

export function messageRowToFull(r: MessageRow, body: StoredBody, attachments: Attachment[]): MessageFull {
  let auth: AuthResults | null = null;
  if (r.auth_json) try { auth = JSON.parse(r.auth_json); } catch { /* ignore */ }
  return {
    id: r.id, threadId: r.thread_id, folderId: r.folder_id, direction: r.direction, status: r.status,
    messageIdHeader: r.message_id_hdr, parentId: r.parent_id, composeMode: r.compose_mode,
    from: r.from_name ? { email: r.from_email, name: r.from_name } : { email: r.from_email },
    to: parseJsonAddresses(r.to_json), cc: parseJsonAddresses(r.cc_json), bcc: parseJsonAddresses(r.bcc_json),
    replyTo: r.reply_to, subject: r.subject, snippet: r.snippet,
    html: body.html ? rewriteCids(body.html, attachments) : body.html, text: body.text, attachments,
    isRead: !!r.is_read, isStarred: !!r.is_starred, spamScore: r.spam_score, auth, listId: r.list_id,
    sendAt: r.send_at, sentAt: r.sent_at, errorCode: r.error_code, errorMessage: r.error_message, date: r.date,
  };
}

/** Full API shape for one message row (body from R2, signed attachment URLs). */
export async function loadMessageFull(env: Env, origin: string, r: MessageRow): Promise<MessageFull> {
  const [{ results }, body] = await Promise.all([
    env.DB.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, id').bind(r.id).all<AttachmentRow>(),
    loadBody(env, r.body_key),
  ]);
  const atts = await Promise.all(results.map((a) => attachmentToApi(env, origin, a)));
  return messageRowToFull(r, body, atts);
}

export function ftsInsertStmt(db: D1Database, m: { id: string; mailboxId: string; subject: string; addresses: string; body: string }) {
  return db.prepare('INSERT INTO messages_fts (message_id, mailbox_id, subject, addresses, body) VALUES (?, ?, ?, ?, ?)')
    .bind(m.id, m.mailboxId, m.subject, m.addresses, m.body.slice(0, 200_000));
}

export function addressesForFts(from: Address, ...lists: Address[][]): string {
  return [from, ...lists.flat()].map((a) => `${a.name ?? ''} ${a.email}`.trim()).join(' ');
}

/**
 * Permanently deletes messages: rows, attachment rows (cascade), FTS rows and R2 objects.
 * R2 keys are only deleted when no other attachment row still references them.
 */
export async function deleteMessagesForever(env: Env, mailboxId: string, messageIds: string[]): Promise<void> {
  if (!messageIds.length) return;
  for (let i = 0; i < messageIds.length; i += 50) {
    const ids = messageIds.slice(i, i + 50);
    const ph = ids.map(() => '?').join(',');
    const [msgs, atts] = await env.DB.batch([
      env.DB.prepare(`SELECT id, thread_id, body_key, raw_key FROM messages WHERE mailbox_id = ? AND id IN (${ph})`).bind(mailboxId, ...ids),
      env.DB.prepare(`SELECT r2_key FROM attachments WHERE mailbox_id = ? AND message_id IN (${ph})`).bind(mailboxId, ...ids),
    ]);
    const rows = msgs.results as { id: string; thread_id: string; body_key: string | null; raw_key: string | null }[];
    if (!rows.length) continue;
    const found = rows.map((r) => r.id);
    const fph = found.map(() => '?').join(',');
    const attKeys = [...new Set((atts.results as { r2_key: string }[]).map((a) => a.r2_key))];
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM messages_fts WHERE message_id IN (${fph})`).bind(...found),
      env.DB.prepare(`DELETE FROM messages WHERE id IN (${fph})`).bind(...found),
      ...[...new Set(rows.map((r) => r.thread_id))].flatMap((t) => recomputeThreadStmts(env.DB, t)),
    ]);
    let orphanAtt: string[] = [];
    if (attKeys.length) {
      const kph = attKeys.map(() => '?').join(',');
      const { results: still } = await env.DB.prepare(`SELECT DISTINCT r2_key FROM attachments WHERE r2_key IN (${kph})`).bind(...attKeys).all<{ r2_key: string }>();
      const keep = new Set(still.map((s) => s.r2_key));
      orphanAtt = attKeys.filter((k) => !keep.has(k));
    }
    const keys = [...rows.flatMap((r) => [r.body_key, r.raw_key]).filter((k): k is string => !!k), ...orphanAtt];
    if (keys.length) await env.BUCKET.delete(keys);
  }
}

export function encodeCursor(k: number, id: string): string {
  return btoa(JSON.stringify([k, id])).replace(/=+$/, '');
}

export function decodeCursor(c: string | undefined | null): { k: number; id: string } | null {
  if (!c) return null;
  try {
    const [k, id] = JSON.parse(atob(c));
    if (typeof k === 'number' && typeof id === 'string') return { k, id };
  } catch { /* invalid */ }
  return null;
}
