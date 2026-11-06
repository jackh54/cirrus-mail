-- OpenPGP, end to end in the browser. The server stores keys but never sees a passphrase or a plaintext private key.
-- One key per user. private_key_enc is an armored private key already encrypted with the user's PGP passphrase
-- (separate from the login password) in the browser.
CREATE TABLE pgp_keys (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  fingerprint     TEXT NOT NULL,                           -- hex, computed by the server from public_key
  public_key      TEXT NOT NULL,                           -- armored
  private_key_enc TEXT NOT NULL,                           -- armored, passphrase-encrypted
  addresses       TEXT NOT NULL DEFAULT '[]',              -- JSON array: the email user IDs on the key (set by the client)
  revoked         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Public keys of other people, per user: email -> key. A different key for the same address never replaces the
-- current one silently; it waits in the pending_* columns until the user accepts it.
CREATE TABLE pgp_keyring (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,                       -- lowercase
  public_key          TEXT NOT NULL,                       -- armored
  fingerprint         TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('manual', 'autocrypt', 'wkd')),
  pending_public_key  TEXT,
  pending_fingerprint TEXT,
  pending_source      TEXT CHECK (pending_source IS NULL OR pending_source IN ('manual', 'autocrypt', 'wkd')),
  pending_at          INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (user_id, email)
);

-- How a draft is sent: 'mime' = body text is an armored OpenPGP message, sent as PGP/MIME (RFC 3156);
-- 'inline' = body text is sent as is (cleartext-signed or armored), text/plain only. NULL = a normal message.
ALTER TABLE messages ADD COLUMN pgp_mode TEXT CHECK (pgp_mode IS NULL OR pgp_mode IN ('mime', 'inline'));
