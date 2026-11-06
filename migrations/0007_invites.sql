-- Account invites: an admin creates the user with an unusable random password and emails a one-time link.
-- One live invite per user; resending replaces the token. Accepting (or an admin password reset) deletes the row.
CREATE TABLE invites (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                         -- sha256 hex of the token; the token itself is never stored
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,                                      -- last successful email, NULL if only a link was made
  expires_at INTEGER NOT NULL
);
