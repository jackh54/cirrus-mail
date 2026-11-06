// scheduled(): every minute send due scheduled messages; at minute 0 purge and prune.
import { deleteMessagesForever, type MessageRow } from './lib/db';
import { claimForSend, mailboxMemberIds, performSend } from './outbound/send';

const DAY = 24 * 3600 * 1000;
const MAX_SENDS_PER_TICK = 25;
const STUCK_AFTER_MS = 15 * 60 * 1000;

export async function sendDueScheduled(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT ?",
  ).bind(now, MAX_SENDS_PER_TICK).all<MessageRow>();
  let sent = 0;
  for (const row of results) {
    // Claim: only one tick (or the API) can move a row from scheduled to sending.
    if (!(await claimForSend(env.DB, row.id, ['scheduled']))) continue;
    const res = await performSend(env, row, await mailboxMemberIds(env.DB, row.mailbox_id));
    if (res.ok) sent++;
  }
  return sent;
}

export async function hourlyMaintenance(env: Env, now = Date.now()): Promise<void> {
  const db = env.DB;
  // Hard-delete Trash and Spam items older than 30 days (rows + R2 objects).
  const { results } = await db.prepare(
    `SELECT m.id, m.mailbox_id FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE f.role IN ('trash','spam') AND m.folder_changed_at < ? LIMIT 500`,
  ).bind(now - 30 * DAY).all<{ id: string; mailbox_id: string }>();
  const byMailbox = new Map<string, string[]>();
  for (const r of results) byMailbox.set(r.mailbox_id, [...(byMailbox.get(r.mailbox_id) ?? []), r.id]);
  for (const [mb, ids] of byMailbox) await deleteMessagesForever(env, mb, ids);

  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE window_end < ?').bind(now),
    db.prepare('DELETE FROM autoreply_log WHERE sent_at < ?').bind(now - 30 * DAY),
    // A send interrupted mid-flight (isolate killed) would stay 'sending' forever; surface it as failed.
    db.prepare(
      `UPDATE messages SET status = 'failed', error_code = 'E_INTERRUPTED', error_message = 'Sending was interrupted. Try again.',
         folder_id = (SELECT id FROM folders WHERE mailbox_id = messages.mailbox_id AND role = 'drafts'), updated_at = ?
       WHERE status = 'sending' AND updated_at < ?`,
    ).bind(now, now - STUCK_AFTER_MS),
  ]);
}

export async function runCron(env: Env, scheduledTime: number): Promise<void> {
  try {
    await sendDueScheduled(env);
  } catch (e) {
    console.error('cron send error', (e as Error).name);
  }
  if (new Date(scheduledTime).getUTCMinutes() === 0) {
    try {
      await hourlyMaintenance(env);
    } catch (e) {
      console.error('cron maintenance error', (e as Error).name);
    }
  }
}
