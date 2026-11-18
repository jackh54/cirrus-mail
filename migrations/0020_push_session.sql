-- Push subscriptions are credentials of the session that created them (security audit 2026-11-18).
-- Deleting a session (logout, revoke, password change, admin reset or disable, expiry) deletes its subscriptions,
-- so a stolen session cannot leave a browser behind that keeps receiving new-mail alerts.
-- Rows created before this migration have no session; the revocation paths delete those explicitly.
ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
CREATE INDEX idx_push_session ON push_subscriptions(session_id);
