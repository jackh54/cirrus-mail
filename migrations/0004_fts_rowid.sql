-- Each message records the rowid of its messages_fts row, so FTS updates and deletes look it up by rowid
-- instead of scanning (messages_fts.message_id is UNINDEXED). Messages left NULL fall back to the old scan.
ALTER TABLE messages ADD COLUMN fts_rowid INTEGER;
UPDATE messages SET fts_rowid = f.rowid FROM messages_fts f WHERE f.message_id = messages.id;
