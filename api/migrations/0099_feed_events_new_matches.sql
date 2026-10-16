-- A new feed event type, new_matches: the one summary row per day that tells
-- everyone routine new keyword matches arrived. It belongs to no bill (bill_id is
-- NULL, which 0093 allowed) and keeps the bills it counts as metadata.billIds.
-- The queue processor writes it, once a routine match is above the instance's
-- minimum relevance, by adding the bill to the day's row.
--
-- SQLite can't ALTER a CHECK, so rebuild the table. Mirrors migration 0093,
-- and re-creates every index the way it does. Any later rebuild of this table
-- must do the same, including the unique index below and any index added after.
--
-- idx_feed_events_new_matches_day allows one new_matches row per UTC day. The
-- processor adds each match with an upsert on it, so two matches processed at
-- once land on one row and none is lost to a read-then-write race.
--
-- No existing event becomes a new_matches row. Matches that exist before this
-- migration carry no provenance, count as bulk, and never appear in the feed.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE feed_events_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'bill_added', 'priority_set', 'position_set', 'comment_added', 'vote_milestone', 'bill_updated',
    'hearing_added', 'hearing_changed', 'hearing_cancelled', 'bill_matched', 'new_matches'
  )),
  bill_id TEXT REFERENCES bills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  suppressed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO feed_events_new (id, type, bill_id, user_id, metadata, suppressed, created_at)
  SELECT id, type, bill_id, user_id, metadata, suppressed, created_at FROM feed_events;
DROP TABLE feed_events;
ALTER TABLE feed_events_new RENAME TO feed_events;
CREATE INDEX idx_feed_events_bill_id ON feed_events(bill_id);
CREATE INDEX idx_feed_events_created ON feed_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_events_created_dt ON feed_events(datetime(created_at));
CREATE UNIQUE INDEX idx_feed_events_new_matches_day ON feed_events(date(created_at)) WHERE type = 'new_matches';
