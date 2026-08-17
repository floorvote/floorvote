-- Speed up the two slowest /bills/facets GROUP BY queries on large multi-state
-- tenants (measured on e.floor.vote, ~52k bills: priority ~110ms, year_start
-- ~130ms, versus ~4ms for the already-indexed status/state/session facets).
--
-- year_start has never had a standalone index. It appears only inside the
-- composite idx_bills_tracked_cover (0057), which is partial on
-- match_type IS NOT NULL and so cannot serve a full-population GROUP BY.
--
-- priority has a longer story worth recording, because the loss was silent.
-- 0003 created idx_bills_priority as a PARTIAL index (WHERE priority IS NOT
-- NULL). 0025_openstates_tenant then did DROP TABLE IF EXISTS bills and
-- recreated it, which drops every index on the table with it. 0025 and its
-- successors restored the state/session/status indexes but never priority, so
-- from 0025 onward bills.priority has had no index at all.
--
-- The DROP below is therefore a no-op on every database that has run 0025 in
-- sequence — which is all of them. It exists so that a database restored from a
-- pre-0025 backup, or hand-patched, cannot leave the stale partial index in
-- place and have CREATE INDEX IF NOT EXISTS silently skip the replacement. That
-- failure would be invisible: the facets endpoint would simply stay slow.
--
-- The replacement is deliberately NOT partial. The facets query groups over the
-- whole population and must count the NULL-priority rows, which are exactly the
-- rows a WHERE priority IS NOT NULL index excludes.
DROP INDEX IF EXISTS idx_bills_priority;

CREATE INDEX IF NOT EXISTS idx_bills_priority ON bills(priority);

CREATE INDEX IF NOT EXISTS idx_bills_year_start ON bills(year_start);

-- SQLite will not choose the new indexes over an existing scan plan until the
-- stat tables are rebuilt — same reason 0057 ends this way.
ANALYZE;
