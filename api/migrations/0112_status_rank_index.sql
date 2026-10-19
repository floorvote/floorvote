-- The facets response names each status label's stage and highest rank (statusGroups,
-- #677). That is a GROUP BY status, stage over the bills the facets' filter meets,
-- with MAX of the rank. No index carried the rank, so each facets request read every
-- bill row it met. With the rank in the index the statement reads the index alone.
--
-- A rank can't be derived from the label, since providers share labels and rank them
-- differently, and each provider's vocabulary lives in central, not here.
--
-- ANALYZE bills gives the planner the new index's statistics.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE INDEX IF NOT EXISTS idx_bills_status_rank ON bills(status, status_stage, status_rank);

ANALYZE bills;
