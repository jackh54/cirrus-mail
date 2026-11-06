-- Passkeys (WebAuthn). Credentials belong to a user and vanish with them (ON DELETE CASCADE).
CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,                      -- base64url credential id, as the authenticator reports it
  public_key    TEXT NOT NULL,                             -- base64url COSE_Key exactly as registered
  alg           INTEGER NOT NULL,                          -- COSE algorithm: -7 ES256, -257 RS256, -8 EdDSA
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                                      -- JSON array of transport hints, or NULL
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

-- Single-use challenges. Consumed with DELETE ... RETURNING, so a challenge can be spent once.
-- user_id is set for registration (bound to the signed-in user) and NULL for sign-in.
CREATE TABLE webauthn_challenges (
  challenge  TEXT PRIMARY KEY,                             -- base64url of 32 random bytes
  purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
