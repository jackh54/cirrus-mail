-- Cirrus Mail initial schema. Never edit after it has been applied; add 0002_*.sql instead.
-- IDs are ULID text. Timestamps are epoch milliseconds (INTEGER).

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,     -- login identifier
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  totp_secret   TEXT,                                     -- base32, set once enabled
  totp_pending  TEXT,                                     -- base32, during enrolment
  theme         TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  density       TEXT NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable','compact')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                          -- ULID (public handle)
  token_hash   TEXT NOT NULL UNIQUE,                      -- sha256(token) hex
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE recovery_codes (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER
);
CREATE INDEX idx_recovery_user ON recovery_codes(user_id);

CREATE TABLE domains (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  catch_all_mailbox_id TEXT,                              -- FK added logically (mailboxes created later)
  created_at           INTEGER NOT NULL
);

CREATE TABLE mailboxes (
  id             TEXT PRIMARY KEY,
  domain_id      TEXT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
  local_part     TEXT NOT NULL COLLATE NOCASE,
  address        TEXT NOT NULL UNIQUE COLLATE NOCASE,     -- local_part@domain, denormalised
  display_name   TEXT NOT NULL DEFAULT '',
  signature_html TEXT NOT NULL DEFAULT '',
  autoreply_enabled INTEGER NOT NULL DEFAULT 0,
  autoreply_subject TEXT NOT NULL DEFAULT '',
  autoreply_body    TEXT NOT NULL DEFAULT '',
  autoreply_start   INTEGER,
  autoreply_end     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_mailboxes_domain ON mailboxes(domain_id);

CREATE TABLE mailbox_members (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX idx_members_user ON mailbox_members(user_id);

CREATE TABLE aliases (
  id         TEXT PRIMARY KEY,
  address    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  can_send   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_aliases_mailbox ON aliases(mailbox_id);

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  role       TEXT CHECK (role IN ('inbox','sent','drafts','archive','spam','trash','scheduled')),
  sort       INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  UNIQUE (mailbox_id, name)
);
CREATE UNIQUE INDEX idx_folders_role ON folders(mailbox_id, role) WHERE role IS NOT NULL;

CREATE TABLE threads (
  id              TEXT PRIMARY KEY,
  mailbox_id      TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  subject         TEXT NOT NULL DEFAULT '',
  subject_norm    TEXT NOT NULL DEFAULT '',
  snippet         TEXT NOT NULL DEFAULT '',
  participants    TEXT NOT NULL DEFAULT '[]',            -- JSON [{name,email}]
  message_count   INTEGER NOT NULL DEFAULT 0,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_starred      INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_threads_mailbox_last ON threads(mailbox_id, last_message_at DESC);
CREATE INDEX idx_threads_subject ON threads(mailbox_id, subject_norm, last_message_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  mailbox_id      TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  folder_id       TEXT NOT NULL REFERENCES folders(id),
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  status          TEXT NOT NULL CHECK (status IN ('received','draft','scheduled','sending','sent','failed')),
  message_id_hdr  TEXT,                                   -- RFC 5322 Message-ID (incoming header or value returned by send())
  in_reply_to     TEXT,
  references_hdr  TEXT,                                   -- space-separated ids
  parent_id       TEXT,                                   -- our message this one replies to / forwards (drafts)
  compose_mode    TEXT CHECK (compose_mode IN ('new','reply','reply_all','forward')),
  from_email      TEXT NOT NULL DEFAULT '',
  from_name       TEXT NOT NULL DEFAULT '',
  to_json         TEXT NOT NULL DEFAULT '[]',
  cc_json         TEXT NOT NULL DEFAULT '[]',
  bcc_json        TEXT NOT NULL DEFAULT '[]',
  reply_to        TEXT,
  subject         TEXT NOT NULL DEFAULT '',
  snippet         TEXT NOT NULL DEFAULT '',
  body_key        TEXT,                                   -- R2 key of {html,text} JSON
  raw_key         TEXT,                                   -- R2 key of raw .eml (incoming)
  size            INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_read         INTEGER NOT NULL DEFAULT 0,
  is_starred      INTEGER NOT NULL DEFAULT 0,
  spam_score      INTEGER NOT NULL DEFAULT 0,
  auth_json       TEXT,                                   -- {spf,dkim,dmarc}
  list_id         TEXT,
  send_at         INTEGER,
  sent_at         INTEGER,
  error_code      TEXT,
  error_message   TEXT,
  date            INTEGER NOT NULL,                       -- display date (Date header or send time)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  folder_changed_at INTEGER NOT NULL                      -- for 30-day Trash/Spam purge
);
CREATE INDEX idx_messages_thread ON messages(thread_id, date);
CREATE INDEX idx_messages_folder ON messages(mailbox_id, folder_id, date DESC);
CREATE INDEX idx_messages_msgid ON messages(mailbox_id, message_id_hdr);
CREATE INDEX idx_messages_scheduled ON messages(status, send_at) WHERE status = 'scheduled';
CREATE INDEX idx_messages_purge ON messages(folder_id, folder_changed_at);

CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL,
  content_id TEXT,                                        -- without <>
  inline     INTEGER NOT NULL DEFAULT 0,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

-- Full-text search. rowid is not used as a key; message_id joins back to messages.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED,
  mailbox_id UNINDEXED,
  subject,
  addresses,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE contacts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        TEXT NOT NULL COLLATE NOCASE,
  name         TEXT NOT NULL DEFAULT '',
  times_used   INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL,
  UNIQUE (user_id, email)
);

CREATE TABLE filters (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  match      TEXT NOT NULL DEFAULT 'all' CHECK (match IN ('all','any')),
  conditions TEXT NOT NULL,                               -- JSON FilterCondition[]
  actions    TEXT NOT NULL,                               -- JSON FilterAction[]
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_filters_mailbox ON filters(mailbox_id, sort);

CREATE TABLE blocked_senders (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  pattern    TEXT NOT NULL COLLATE NOCASE,                -- full address or @domain
  created_at INTEGER NOT NULL,
  UNIQUE (mailbox_id, pattern)
);

CREATE TABLE autoreply_log (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL COLLATE NOCASE,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, sender)
);

CREATE TABLE send_log (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  message_id TEXT,
  recipients INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_send_log_created ON send_log(created_at);

CREATE TABLE receive_log (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT,
  accepted   INTEGER NOT NULL,
  reason     TEXT,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_receive_log_created ON receive_log(created_at);

CREATE TABLE rate_limits (
  key        TEXT PRIMARY KEY,                            -- e.g. login:<ip>:<email>
  count      INTEGER NOT NULL,
  window_end INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
