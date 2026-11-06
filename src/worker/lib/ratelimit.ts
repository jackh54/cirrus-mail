// Fixed-window counters in the rate_limits table. Increment first, atomically, then decide.

/** Adds one hit to `key` and returns the count in the current window. */
export async function hit(db: D1Database, key: string, windowMs: number, now = Date.now()): Promise<number> {
  const row = await db.prepare(
    `INSERT INTO rate_limits (key, count, window_end) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_end < ?3 THEN 1 ELSE count + 1 END,
       window_end = CASE WHEN window_end < ?3 THEN ?2 ELSE window_end END
     RETURNING count`,
  ).bind(key, now + windowMs, now).first<{ count: number }>();
  return row?.count ?? 1;
}

/** Takes back one hit (used when an attempt turned out to be legitimate). */
export async function unhit(db: D1Database, key: string): Promise<void> {
  await db.prepare('UPDATE rate_limits SET count = MAX(0, count - 1) WHERE key = ?').bind(key).run();
}

export async function clear(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}
