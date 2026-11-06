-- App passwords (Basic auth for DAV, later JMAP) and the CardDAV / CalDAV store.
-- App passwords are high-entropy random secrets, so a plain sha256 is enough (no per-request scrypt cost).
CREATE TABLE app_passwords (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,                        -- sha256 hex of the normalised secret; the secret is never stored
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER                                      -- updated at most once an hour
);
CREATE INDEX app_passwords_user ON app_passwords(user_id);

-- Address books and calendars. `rev` is the collection's change counter: it is the CTag and the sync-token.
CREATE TABLE dav_collections (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('addressbook', 'calendar')),
  slug        TEXT NOT NULL,                                -- last URL segment
  displayname TEXT NOT NULL,
  description TEXT,
  color       TEXT,
  components  TEXT NOT NULL DEFAULT 'VEVENT,VTODO',         -- supported-calendar-component-set
  rev         INTEGER NOT NULL DEFAULT 0,
  pruned_rev  INTEGER NOT NULL DEFAULT 0,                   -- change-log rows up to this rev were pruned: older sync tokens expire
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, kind, slug)
);

-- Raw vCard / iCalendar text plus the columns queries need.
CREATE TABLE dav_objects (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES dav_collections(id) ON DELETE CASCADE,
  uri           TEXT NOT NULL,                              -- file name inside the collection
  uid           TEXT NOT NULL,
  etag          TEXT NOT NULL,                              -- sha256 hex of the content (strong)
  size          INTEGER NOT NULL,
  data          TEXT NOT NULL,
  component     TEXT,                                       -- VEVENT | VTODO (calendars)
  dtstart       INTEGER,                                    -- UTC epoch ms; earliest start in the resource, NULL if undated
  dtend         INTEGER,                                    -- latest end of the non-recurring parts
  recurring     INTEGER NOT NULL DEFAULT 0,                 -- has an RRULE or RDATE
  rec_until     INTEGER,                                    -- recurring only: end of the last occurrence, NULL = unbounded
  approx        INTEGER NOT NULL DEFAULT 0,                 -- floating / all-day / unknown zone: queries pad by a day
  fn            TEXT,                                       -- vCard formatted name
  emails        TEXT,                                       -- vCard emails, lower-case, newline separated
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (collection_id, uri)
);
CREATE INDEX dav_objects_uid ON dav_objects(collection_id, uid);
CREATE INDEX dav_objects_start ON dav_objects(collection_id, dtstart);

-- Change log behind sync-collection (RFC 6578): one row per write, pruned by cron.
CREATE TABLE dav_changes (
  collection_id TEXT NOT NULL REFERENCES dav_collections(id) ON DELETE CASCADE,
  rev           INTEGER NOT NULL,
  uri           TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (collection_id, rev)
);
CREATE INDEX dav_changes_age ON dav_changes(created_at);
