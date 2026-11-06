-- Outbound sends per UTC day (one per recipient), counted after Email Sending accepts them, for the daily-limit
-- meter. The limit itself is the 'daily_send_limit' row in settings (set by an admin; Cloudflare doesn't expose it).
CREATE TABLE send_counts (
  day  TEXT PRIMARY KEY,                -- YYYY-MM-DD, UTC
  sent INTEGER NOT NULL DEFAULT 0
);

-- Backfill from send_log so today's meter (and the last 60 days) are right on the day this ships.
INSERT INTO send_counts (day, sent)
  SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch'), SUM(recipients)
    FROM send_log WHERE ok = 1 AND created_at >= (unixepoch('now', '-60 days') * 1000)
   GROUP BY 1;
