-- A new feed event type, no_priority_updates: the one row per day that stands
-- for the legislative activity on analyzed bills with no priority. It belongs to
-- no bill (bill_id is NULL, which 0093 allowed). Unlike new_matches it stores no
-- bills: which bills it lists is resolved each time the feed loads, so a bill
-- that gains a priority or the team's attention that day leaves it.
-- The queue processor writes it as passive events land on analyzed bills.
--
-- SQLite can't ALTER a CHECK, so rebuild the table. Mirrors migration 0099,
-- and re-creates every index the way it does. Any later rebuild of this table
-- must do the same, including both unique indexes below and any index added after.
--
-- idx_feed_events_no_priority_updates_day allows one no_priority_updates row per
-- UTC day. The processor writes it with an insert that does nothing on that
-- index, so two updates processed at once land on one row.
--
-- Safe to run twice. The leftover table of a run that stopped part way is
-- dropped first, and every index is created only if it is missing.
-- No existing event changes type, and none is written here.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
DROP TABLE IF EXISTS feed_events_new;
CREATE TABLE feed_events_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'bill_added', 'priority_set', 'position_set', 'comment_added', 'vote_milestone', 'bill_updated',
    'hearing_added', 'hearing_changed', 'hearing_cancelled', 'bill_matched', 'new_matches', 'no_priority_updates'
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
CREATE INDEX IF NOT EXISTS idx_feed_events_bill_id ON feed_events(bill_id);
CREATE INDEX IF NOT EXISTS idx_feed_events_created ON feed_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_events_created_dt ON feed_events(datetime(created_at));
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_events_new_matches_day ON feed_events(date(created_at)) WHERE type = 'new_matches';
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_events_no_priority_updates_day ON feed_events(date(created_at)) WHERE type = 'no_priority_updates';
