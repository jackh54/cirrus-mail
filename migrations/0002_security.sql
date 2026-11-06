-- Security hardening (review 2026-11-05).
-- TOTP replay protection: the last accepted 30 s step per user; codes at or below it are rejected.
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
-- The user who scheduled a send, so the cron can re-check membership before delivering.
ALTER TABLE messages ADD COLUMN scheduled_by TEXT;
