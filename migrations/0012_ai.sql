-- Optional AI triage (Workers AI). Off until an admin sets settings 'ai_enabled' = '1'; the daily call cap is the
-- 'ai_daily_budget' row (default 500). NULL category means "not classified", shown as Primary.
ALTER TABLE threads ADD COLUMN category TEXT CHECK (category IN ('primary','updates','promotions','social','forums'));
ALTER TABLE users ADD COLUMN category_tabs INTEGER NOT NULL DEFAULT 1;

-- AI calls per UTC day (same shape as send_counts).
CREATE TABLE ai_usage (
  day   TEXT PRIMARY KEY,               -- YYYY-MM-DD, UTC
  calls INTEGER NOT NULL DEFAULT 0
);

-- "Always put mail from this sender in this tab", per mailbox. Set when a thread is recategorised by hand.
CREATE TABLE sender_categories (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL COLLATE NOCASE,
  category   TEXT NOT NULL CHECK (category IN ('primary','updates','promotions','social','forums')),
  PRIMARY KEY (mailbox_id, sender)
);

-- One cached summary per thread. `fingerprint` (visible message count + newest message id) goes stale when mail arrives.
CREATE TABLE thread_summaries (
  thread_id   TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  bullets     TEXT NOT NULL,            -- JSON string[]
  created_at  INTEGER NOT NULL
);
