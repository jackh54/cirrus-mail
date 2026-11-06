-- JMAP (RFC 8620 / 8621) change tracking, done with triggers so no write path has to know about it (2026-11-06).
-- modseq = the per-mailbox change counter value at the row's last change; cseq = its value when the row was created.
-- State strings handed to clients are the per-type high-water marks kept in jmap_state.
ALTER TABLE messages ADD COLUMN modseq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN cseq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN modseq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN cseq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN modseq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN cseq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labels ADD COLUMN modseq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE labels ADD COLUMN cseq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_modseq ON messages(mailbox_id, modseq);
CREATE INDEX idx_threads_modseq ON threads(mailbox_id, modseq);

-- One row per mailbox. No foreign key: triggers also fire while a mailbox is being cascade-deleted; cron removes orphans.
CREATE TABLE jmap_state (
  mailbox_id TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL DEFAULT 0,   -- the counter
  email      INTEGER NOT NULL DEFAULT 0,   -- seq at the last Email change
  mailbox    INTEGER NOT NULL DEFAULT 0,   -- ... last Mailbox change (folders, labels, and message changes that move counts)
  thread     INTEGER NOT NULL DEFAULT 0,   -- ... last Thread change
  pruned     INTEGER NOT NULL DEFAULT 0    -- tombstones up to this seq were pruned: older sinceStates get cannotCalculateChanges
);

CREATE TABLE jmap_tombstones (
  mailbox_id TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('Email', 'Thread', 'Mailbox')),
  id         TEXT NOT NULL,
  modseq     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, type, id)
);
CREATE INDEX idx_jmap_tombstones_modseq ON jmap_tombstones(mailbox_id, type, modseq);
CREATE INDEX idx_jmap_tombstones_age ON jmap_tombstones(created_at);

-- Blobs uploaded through /jmap/upload. The R2 object is jmapup/<mailbox>/<id>; cron removes both after the TTL.
CREATE TABLE jmap_uploads (
  id         TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  size       INTEGER NOT NULL,
  type       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_jmap_uploads_age ON jmap_uploads(created_at);

-- ---------- messages ----------
CREATE TRIGGER jmap_msg_ai AFTER INSERT ON messages BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (NEW.mailbox_id, 1, 1, 1, 1)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, email = seq + 1, mailbox = seq + 1, thread = seq + 1;
  UPDATE messages SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id), cseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id) WHERE id = NEW.id;
  UPDATE threads SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id),
                     cseq = CASE WHEN cseq = 0 THEN (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id) ELSE cseq END
   WHERE id = NEW.thread_id;
END;

-- Only columns a JMAP Email exposes count; fts_rowid, body_inline backfills, updated_at touches and the like do not.
CREATE TRIGGER jmap_msg_au AFTER UPDATE ON messages
WHEN NEW.modseq IS OLD.modseq AND (
     NEW.folder_id IS NOT OLD.folder_id OR NEW.is_read IS NOT OLD.is_read OR NEW.is_starred IS NOT OLD.is_starred
  OR NEW.status IS NOT OLD.status OR NEW.subject IS NOT OLD.subject OR NEW.body_key IS NOT OLD.body_key
  OR NEW.to_json IS NOT OLD.to_json OR NEW.cc_json IS NOT OLD.cc_json OR NEW.bcc_json IS NOT OLD.bcc_json
  OR NEW.from_email IS NOT OLD.from_email OR NEW.from_name IS NOT OLD.from_name OR NEW.has_attachments IS NOT OLD.has_attachments
  OR NEW.size IS NOT OLD.size OR NEW.message_id_hdr IS NOT OLD.message_id_hdr OR NEW.date IS NOT OLD.date)
BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (NEW.mailbox_id, 1, 1, 1, 0)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, email = seq + 1,
      mailbox = CASE WHEN NEW.folder_id IS NOT OLD.folder_id OR NEW.is_read IS NOT OLD.is_read OR NEW.status IS NOT OLD.status THEN seq + 1 ELSE mailbox END;
  UPDATE messages SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id) WHERE id = NEW.id;
END;

CREATE TRIGGER jmap_msg_ad AFTER DELETE ON messages BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (OLD.mailbox_id, 1, 1, 1, 1)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, email = seq + 1, mailbox = seq + 1, thread = seq + 1;
  INSERT OR REPLACE INTO jmap_tombstones (mailbox_id, type, id, modseq, created_at)
    VALUES (OLD.mailbox_id, 'Email', OLD.id, (SELECT seq FROM jmap_state WHERE mailbox_id = OLD.mailbox_id), CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  UPDATE threads SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = OLD.mailbox_id) WHERE id = OLD.thread_id;
END;

-- ---------- message_labels (a label change is an Email change) ----------
CREATE TRIGGER jmap_ml_ai AFTER INSERT ON message_labels BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread)
    SELECT mailbox_id, 1, 1, 1, 0 FROM messages WHERE id = NEW.message_id
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, email = seq + 1, mailbox = seq + 1;
  UPDATE messages SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = messages.mailbox_id) WHERE id = NEW.message_id;
END;

CREATE TRIGGER jmap_ml_ad AFTER DELETE ON message_labels BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread)
    SELECT mailbox_id, 1, 1, 1, 0 FROM messages WHERE id = OLD.message_id
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, email = seq + 1, mailbox = seq + 1;
  UPDATE messages SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = messages.mailbox_id) WHERE id = OLD.message_id;
END;

-- ---------- threads (creation is tracked by the message insert; only deletion needs its own trigger) ----------
CREATE TRIGGER jmap_thr_ad AFTER DELETE ON threads BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (OLD.mailbox_id, 1, 0, 0, 1)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, thread = seq + 1;
  INSERT OR REPLACE INTO jmap_tombstones (mailbox_id, type, id, modseq, created_at)
    VALUES (OLD.mailbox_id, 'Thread', OLD.id, (SELECT seq FROM jmap_state WHERE mailbox_id = OLD.mailbox_id), CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

-- ---------- folders ----------
CREATE TRIGGER jmap_fld_ai AFTER INSERT ON folders BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (NEW.mailbox_id, 1, 0, 1, 0)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, mailbox = seq + 1;
  UPDATE folders SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id), cseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id) WHERE id = NEW.id;
END;

CREATE TRIGGER jmap_fld_au AFTER UPDATE ON folders
WHEN NEW.modseq IS OLD.modseq AND (NEW.name IS NOT OLD.name OR NEW.sort IS NOT OLD.sort OR NEW.role IS NOT OLD.role)
BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (NEW.mailbox_id, 1, 0, 1, 0)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, mailbox = seq + 1;
  UPDATE folders SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id) WHERE id = NEW.id;
END;

CREATE TRIGGER jmap_fld_ad AFTER DELETE ON folders BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (OLD.mailbox_id, 1, 0, 1, 0)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, mailbox = seq + 1;
  INSERT OR REPLACE INTO jmap_tombstones (mailbox_id, type, id, modseq, created_at)
    VALUES (OLD.mailbox_id, 'Mailbox', OLD.id, (SELECT seq FROM jmap_state WHERE mailbox_id = OLD.mailbox_id), CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

-- ---------- labels ----------
CREATE TRIGGER jmap_lbl_ai AFTER INSERT ON labels BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (NEW.mailbox_id, 1, 0, 1, 0)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, mailbox = seq + 1;
  UPDATE labels SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id), cseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id) WHERE id = NEW.id;
END;

CREATE TRIGGER jmap_lbl_au AFTER UPDATE ON labels
WHEN NEW.modseq IS OLD.modseq AND (NEW.name IS NOT OLD.name OR NEW.color IS NOT OLD.color)
BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (NEW.mailbox_id, 1, 0, 1, 0)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, mailbox = seq + 1;
  UPDATE labels SET modseq = (SELECT seq FROM jmap_state WHERE mailbox_id = NEW.mailbox_id) WHERE id = NEW.id;
END;

CREATE TRIGGER jmap_lbl_ad AFTER DELETE ON labels BEGIN
  INSERT INTO jmap_state (mailbox_id, seq, email, mailbox, thread) VALUES (OLD.mailbox_id, 1, 0, 1, 0)
    ON CONFLICT(mailbox_id) DO UPDATE SET seq = seq + 1, mailbox = seq + 1;
  INSERT OR REPLACE INTO jmap_tombstones (mailbox_id, type, id, modseq, created_at)
    VALUES (OLD.mailbox_id, 'Mailbox', OLD.id, (SELECT seq FROM jmap_state WHERE mailbox_id = OLD.mailbox_id), CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
