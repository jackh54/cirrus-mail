-- Labels: tags a message (and so a thread) can carry in any number, separate from folders.
-- Stored per message so per-message mailbox membership stays possible; a thread's labels are the union over its messages.
CREATE TABLE labels (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL COLLATE NOCASE,
  color      TEXT NOT NULL,                                -- one of LABEL_COLORS (src/shared/api.ts)
  created_at INTEGER NOT NULL,
  UNIQUE (mailbox_id, name)
);

CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id   TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX idx_message_labels_label ON message_labels(label_id, message_id);
