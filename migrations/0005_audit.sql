-- Security audit fixes (2026-11-05).
-- Who created a filter. forward_to actions only run while this user is an active member of the mailbox;
-- existing filters keep NULL, so their forwards stop until an owner or admin saves them again.
ALTER TABLE filters ADD COLUMN created_by TEXT;
-- Inbound duplicate suppression compares this hash (identifying headers, auth verdict and the raw body) as
-- well as the Message-ID, so a planted message reusing a Message-ID cannot swallow a different one.
ALTER TABLE messages ADD COLUMN content_hash TEXT;
-- The sender's Date header, clamped to [received - 7 days, received + 5 minutes], shown as the message date.
-- For new inbound mail messages.date is the received time, so thread order and thread subject follow arrival.
ALTER TABLE messages ADD COLUMN display_date INTEGER;
