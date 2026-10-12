-- Let a feed event have no bill. A bulk edit of many bills is one event about
-- all of them, and pinning it to the first bill made it read as that bill's
-- activity and made it vanish when that bill was deleted.
--
-- bill_id loses NOT NULL and keeps its foreign key. A NULL bill_id never
-- cascades, so a bill-less event survives any bill's deletion. SQLite can't
-- ALTER a NOT NULL, so rebuild the table. Mirrors migrations 0016, 0043 and 0053,
-- and re-creates both indexes the way 0062 had to. Any later rebuild of this
-- table must do the same, including any index added after this one.
--
-- Existing bulk events (metadata isBulk) were pinned to the first bill of the
-- batch and stored only a count. They become bill-less here, and keep the one
-- bill id they hold as billIds. The rest of the batch cannot be recovered, so
-- they read as "N bills" and list only that one bill.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE feed_events_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'bill_added', 'priority_set', 'position_set', 'comment_added', 'vote_milestone', 'bill_updated',
    'hearing_added', 'hearing_changed', 'hearing_cancelled', 'bill_matched'
  )),
  bill_id TEXT REFERENCES bills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  suppressed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO feed_events_new (id, type, bill_id, user_id, metadata, suppressed, created_at)
  SELECT
    id,
    type,
    CASE WHEN json_valid(metadata) AND json_extract(metadata, '$.isBulk') = 1 THEN NULL ELSE bill_id END,
    user_id,
    CASE WHEN json_valid(metadata) AND json_extract(metadata, '$.isBulk') = 1
      THEN json_set(json_remove(metadata, '$.isBulk'), '$.billIds', json_array(bill_id))
      ELSE metadata END,
    suppressed,
    created_at
  FROM feed_events;
DROP TABLE feed_events;
ALTER TABLE feed_events_new RENAME TO feed_events;
CREATE INDEX idx_feed_events_bill_id ON feed_events(bill_id);
CREATE INDEX idx_feed_events_created ON feed_events(created_at DESC);
