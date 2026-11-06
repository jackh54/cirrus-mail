// Daily outbound counter for the sending-limit meter. Counts only; Cloudflare enforces the real limit.
import type { SendingStatus } from '../../shared/api';

export const DAILY_LIMIT_KEY = 'daily_send_limit';

/** 'YYYY-MM-DD' of the UTC day containing `now`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function dayStart(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export async function recordSends(db: D1Database, count: number, now: number): Promise<void> {
  if (count <= 0) return;
  await db.prepare('INSERT INTO send_counts (day, sent) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET sent = sent + excluded.sent')
    .bind(utcDay(now), count).run();
}

/** recordSends for callers that already sent successfully: a counter failure is logged, never raised. */
export async function recordSendsSafe(db: D1Database, count: number, now = Date.now()): Promise<void> {
  try {
    await recordSends(db, count, now);
  } catch (e) {
    console.error('send count failed', (e as Error).name);
  }
}

/** Parses the stored setting: a positive integer string, else null. */
export function parseLimit(v: string | null | undefined): number | null {
  const n = v == null ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function sendingStatus(db: D1Database, now: number): Promise<SendingStatus> {
  const [sent, limit] = await db.batch([
    db.prepare('SELECT sent FROM send_counts WHERE day = ?').bind(utcDay(now)),
    db.prepare('SELECT value FROM settings WHERE key = ?').bind(DAILY_LIMIT_KEY),
  ]);
  return {
    dailyLimit: parseLimit((limit.results[0] as { value: string } | undefined)?.value),
    sentToday: (sent.results[0] as { sent: number } | undefined)?.sent ?? 0,
    dayStartsAt: dayStart(now),
  };
}
