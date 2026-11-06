// Waking snoozed threads (cron, every minute).
import { recomputeThreadStmts } from './lib/db';
import { notifyNewMail } from './push';

export const MAX_WAKES_PER_TICK = 100;

/**
 * Returns due snoozed threads to the top of their Inbox, unread, and pushes the usual new-mail notification.
 * Order is by received time (messages.date), so the thread's latest inbox message is stamped with the wake time
 * (its sender-visible date is kept in display_date). A thread with nothing in the Inbox (archived while
 * snoozed) gets its latest received message moved back in.
 *
 * The claim is the thread's own UPDATE (snoozed_until set → NULL while still due), in the same batch as the
 * message update that is guarded by the same condition: two overlapping runs see the batch serialised, and only
 * the first changes anything, so each thread is woken, and notified, once. Returns the number woken.
 */
export async function wakeDueSnoozed(env: Env, now = Date.now()): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(
    'SELECT id, mailbox_id, muted FROM threads WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? ORDER BY snoozed_until, id LIMIT ?',
  ).bind(now, MAX_WAKES_PER_TICK).all<{ id: string; mailbox_id: string; muted: number }>();
  let woken = 0;
  for (const t of results) {
    const inbox = "(SELECT id FROM folders WHERE mailbox_id = ?3 AND role = 'inbox')";
    const [bump, claim] = await db.batch([
      db.prepare(
        `UPDATE messages SET folder_changed_at = CASE WHEN folder_id = ${inbox} THEN folder_changed_at ELSE ?1 END,
                folder_id = ${inbox}, display_date = COALESCE(display_date, date), date = MAX(date, ?1), is_read = 0, updated_at = ?1
          WHERE id = (SELECT id FROM messages WHERE thread_id = ?2 AND mailbox_id = ?3 AND direction = 'in' AND status = 'received'
                        AND folder_id NOT IN (SELECT id FROM folders WHERE mailbox_id = ?3 AND role IN ('trash','spam'))
                      ORDER BY folder_id = ${inbox} DESC, date DESC, id DESC LIMIT 1)
            AND EXISTS (SELECT 1 FROM threads WHERE id = ?2 AND snoozed_until IS NOT NULL AND snoozed_until <= ?1)`,
      ).bind(now, t.id, t.mailbox_id),
      db.prepare('UPDATE threads SET snoozed_until = NULL WHERE id = ? AND snoozed_until IS NOT NULL AND snoozed_until <= ?').bind(t.id, now),
      ...recomputeThreadStmts(db, t.id),
    ]);
    if (!claim.meta.changes) continue;
    woken++;
    if (!bump.meta.changes || t.muted) continue;
    const m = await db.prepare(
      `SELECT m.from_email, m.from_name, m.subject, mb.address FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
        WHERE m.thread_id = ? AND m.folder_id = (SELECT id FROM folders WHERE mailbox_id = m.mailbox_id AND role = 'inbox')
        ORDER BY m.date DESC, m.id DESC LIMIT 1`,
    ).bind(t.id).first<{ from_email: string; from_name: string; subject: string; address: string }>();
    if (m) {
      await notifyNewMail(env, {
        mailboxId: t.mailbox_id, mailboxAddress: m.address, threadId: t.id,
        from: m.from_name ? { email: m.from_email, name: m.from_name } : { email: m.from_email }, subject: m.subject,
      }, now);
    }
  }
  return woken;
}
