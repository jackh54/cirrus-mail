-- mbox import: one row per import. The file is uploaded to R2 (multipart), then the cron walks it with a persisted
-- byte cursor. At most one import per mailbox is active (uploading or processing).
CREATE TABLE mbox_imports (
  id              TEXT PRIMARY KEY,
  mailbox_id      TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,                      -- who started it; only they upload its parts
  status          TEXT NOT NULL CHECK (status IN ('uploading','processing','done','failed','cancelled')),
  filename        TEXT NOT NULL,
  r2_key          TEXT NOT NULL,                      -- import/<mailbox>/<id>.mbox, deleted when the import ends
  upload_id       TEXT,                               -- R2 multipart upload id while uploading
  size            INTEGER NOT NULL,                   -- declared size in bytes
  folder_id       TEXT,                               -- target folder for files without X-Gmail-Labels
  mark_read       INTEGER NOT NULL DEFAULT 1,
  parts_json      TEXT NOT NULL DEFAULT '[]',         -- uploaded parts [[number, etag], ...]
  cursor          INTEGER NOT NULL DEFAULT 0,         -- byte offset of the first message not yet handled
  skipping        INTEGER NOT NULL DEFAULT 0,         -- 1 while scanning past an oversize message
  imported        INTEGER NOT NULL DEFAULT 0,
  duplicates      INTEGER NOT NULL DEFAULT 0,
  skipped         INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  errors_json     TEXT NOT NULL DEFAULT '[]',         -- first 20 reasons, never message content
  lease_until     INTEGER NOT NULL DEFAULT 0,         -- a cron tick owns the import until then
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE UNIQUE INDEX idx_mbox_imports_active ON mbox_imports(mailbox_id) WHERE status IN ('uploading','processing');
CREATE INDEX idx_mbox_imports_mailbox ON mbox_imports(mailbox_id, created_at DESC);

-- Dedupe of imported messages that have no Message-ID.
CREATE INDEX idx_messages_content_hash ON messages(mailbox_id, content_hash) WHERE content_hash IS NOT NULL;
