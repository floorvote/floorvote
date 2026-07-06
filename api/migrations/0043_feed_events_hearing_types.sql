-- Add hearing_added, hearing_changed, hearing_cancelled to feed_events type CHECK constraint
-- SQLite requires table rebuild to alter CHECK constraint

PRAGMA foreign_keys = OFF;

CREATE TABLE feed_events_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'bill_added', 'priority_set', 'position_set', 'comment_added', 'vote_milestone', 'bill_updated',
    'hearing_added', 'hearing_changed', 'hearing_cancelled'
  )),
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
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

PRAGMA foreign_keys = ON;
