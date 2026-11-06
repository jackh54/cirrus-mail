-- Snooze, mute, one-click unsubscribe and reply templates (2026-11-06).
-- Snooze: the thread leaves the Inbox view until this time (epoch ms); NULL = not snoozed. The cron clears it
-- with an atomic claim and returns the thread to the top of the Inbox.
ALTER TABLE threads ADD COLUMN snoozed_until INTEGER;
-- Mute: new inbound messages in a muted thread skip the Inbox and land in Archive, read, without a push.
ALTER TABLE threads ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_threads_snoozed ON threads(mailbox_id, snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX idx_threads_snooze_due ON threads(snoozed_until) WHERE snoozed_until IS NOT NULL;

-- Parsed List-Unsubscribe, stored only for messages that passed aligned authentication:
-- {"url":"https://...","mailto":"a@b.c","subject":"...","oneClick":true}
ALTER TABLE messages ADD COLUMN unsub_json TEXT;

-- Reply templates (canned responses), shared by every member of the mailbox.
CREATE TABLE reply_templates (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  body_html  TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_reply_templates_mailbox ON reply_templates(mailbox_id, name);
