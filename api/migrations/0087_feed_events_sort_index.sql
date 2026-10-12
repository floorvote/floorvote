-- Expression index for the default feed's sort.
-- The feed orders by datetime(created_at) because feed_events stores two UTC
-- formats that sort differently as plain strings. Wrapping the column in a function
-- made idx_feed_events_created unusable for the sort, so every feed load built a
-- temp B-tree over the whole result set. SQLite only uses an expression index when
-- the query repeats the expression exactly, so api/src/routes/feed.ts must keep
-- ordering by datetime(feed_events.created_at). No data migration is needed.
CREATE INDEX IF NOT EXISTS idx_feed_events_created_dt ON feed_events(datetime(created_at));
