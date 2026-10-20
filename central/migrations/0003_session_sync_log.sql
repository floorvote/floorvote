-- 0003_session_sync_log.sql
-- One row per syncLsSession run -- captures bills checked/changed/queued.

CREATE TABLE session_sync_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at      TEXT NOT NULL DEFAULT (datetime('now')),
  state          TEXT NOT NULL,
  session_id     INTEGER NOT NULL,
  session_name   TEXT NOT NULL,
  bills_checked  INTEGER NOT NULL DEFAULT 0,
  bills_changed  INTEGER NOT NULL DEFAULT 0,
  bills_queued   INTEGER NOT NULL DEFAULT 0
);
