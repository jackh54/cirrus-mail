-- Performance (2026-11-05): covering indexes for the hot mailbox reads.
-- Poll (inbox messages created after `since`), folder counts, inbox unread counts and the thread listing
-- read only these columns, so they are answered from the index without touching table rows.
CREATE INDEX idx_messages_folder_created ON messages(mailbox_id, folder_id, created_at, is_read, thread_id, date);
-- The Starred view: a small partial index instead of scanning the whole mailbox.
CREATE INDEX idx_messages_starred ON messages(mailbox_id, thread_id, date, folder_id) WHERE is_starred = 1;
