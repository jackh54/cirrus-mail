// scheduled(): every minute send due scheduled messages; at minute 0 purge and prune.
import { deleteMessagesForever } from './lib/db';
import { backfillInlineBodies } from './lib/inline-backfill';
import { utcDay } from './lib/sendcount';
import { wakeDueSnoozed } from './snooze';
import { processMboxImports } from './mbox/import';
import { checkScheduled, claimForSend, mailboxMemberIds, performSend, recordOutcome } from './outbound/send';

const DAY = 24 * 3600 * 1000;
const MAX_SENDS_PER_TICK = 25;
const MAX_SENDS_PER_MAILBOX_PER_TICK = 5;
const STUCK_AFTER_MS = 15 * 60 * 1000;

export async function sendDueScheduled(env: Env, now = Date.now()): Promise<number> {
  // Round-robin across mailboxes: every mailbox's oldest due row first, then each one's second, and so on,
  // at most 5 per mailbox, so one mailbox's backlog cannot hold back everyone else's scheduled mail.
  const { results } = await env.DB.prepare(
    `SELECT id FROM (
       SELECT id, send_at, ROW_NUMBER() OVER (PARTITION BY mailbox_id ORDER BY send_at, id) AS rn
         FROM messages WHERE status = 'scheduled' AND send_at <= ?)
      WHERE rn <= ? ORDER BY rn, send_at, id LIMIT ?`,
  ).bind(now, MAX_SENDS_PER_MAILBOX_PER_TICK, MAX_SENDS_PER_TICK).all<{ id: string }>();
  let sent = 0;
  for (const { id } of results) {
    // Claim: only one tick (or the API) can move a row from scheduled to sending. The claim re-reads the row,
    // so a row cancelled, edited or rescheduled since the SELECT above is skipped or sent as it is now.
    const row = await claimForSend(env.DB, id, ['scheduled'], now);
    if (!row) continue;
    // Membership or aliases may have changed since it was scheduled.
    const problem = await checkScheduled(env.DB, row);
    if (problem) {
      await recordOutcome(env, row, { ok: false, ...problem }, []);
      continue;
    }
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
    db.prepare('DELETE FROM send_counts WHERE day < ?').bind(utcDay(now - 60 * DAY)),
    // CalDAV/CardDAV change log: keep 30 days. Record how far it was pruned so older sync tokens are refused (RFC 6578 §3.2).
    db.prepare(
      `UPDATE dav_collections SET pruned_rev = MAX(pruned_rev, COALESCE((SELECT MAX(rev) FROM dav_changes WHERE collection_id = dav_collections.id AND created_at < ?1), 0))`,
    ).bind(now - 30 * DAY),
    db.prepare('DELETE FROM dav_changes WHERE created_at < ?').bind(now - 30 * DAY),
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
  try {
    await wakeDueSnoozed(env);
  } catch (e) {
    console.error('cron snooze error', (e as Error).name);
  }
  try {
    await backfillInlineBodies(env);
  } catch (e) {
    console.error('cron inline backfill error', (e as Error).name);
  }
  if (new Date(scheduledTime).getUTCMinutes() === 0) {
    try {
      await hourlyMaintenance(env);
    } catch (e) {
      console.error('cron maintenance error', (e as Error).name);
    }
  }
  // Last, so its time budget never delays sends or maintenance.
  try {
    await processMboxImports(env);
  } catch (e) {
    console.error('cron mbox import error', (e as Error).name);
  }
}
