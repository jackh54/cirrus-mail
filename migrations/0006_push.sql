-- Web Push notifications for new mail (2026-11-05).
-- One row per browser push subscription. The endpoint is unique: a browser that subscribes again (or signs in
-- as another user) updates the existing row and rebinds it to that user.
CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,                           -- base64url, uncompressed P-256 public key
  auth            TEXT NOT NULL,                           -- base64url, 16-byte auth secret
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  failures        INTEGER NOT NULL DEFAULT 0               -- consecutive failed sends; deleted after 5
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);
-- Whether push notifications show the sender and subject (1) or only "New mail" and the mailbox address (0).
ALTER TABLE users ADD COLUMN push_preview INTEGER NOT NULL DEFAULT 1;
