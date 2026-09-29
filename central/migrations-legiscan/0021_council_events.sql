-- The DC Council's hearing calendar (src/lib/lims-hearings.ts): hearings,
-- roundtables, oversight and budget hearings, mark-ups, legislative and
-- breakfast meetings, most with no bill attached. Synced by cron/sync-lims.ts
-- and read by tenants through GET /api/bills/council-events, which filter it by
-- their own calendar rules.
--
-- A new table only. Nothing existing reads it, so deploy order does not matter.
CREATE TABLE IF NOT EXISTS council_events (
  hearing_id     INTEGER PRIMARY KEY,
  date           TEXT NOT NULL,
  time           TEXT,
  hearing_type   TEXT NOT NULL,
  title          TEXT NOT NULL,
  joint_with     TEXT,
  location       TEXT,
  topics_json    TEXT NOT NULL,
  witness_json   TEXT,
  event_hash     TEXT NOT NULL,
  removed_at     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_council_events_date ON council_events(date);
