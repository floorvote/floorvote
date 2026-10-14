-- Counting a filtered bill list by group (#379). The list shows one row per
-- companion group, and its total counts groups. The bills that meet a filter are
-- counted from the filter's own index, as before groups. Correcting that for
-- groups needs each grouped bill's group key together with the columns the
-- common filters read. So the group key index (0100) now carries them: status,
-- stage, state, session, year, and relevance. A filtered total reads this one
-- small index and no table rows, where without them every grouped bill's row
-- is read.
--
-- The index holds only grouped bills, a fraction of an instance's bills, and an
-- instance with no groups has an empty index. Existing bills stay ungrouped
-- until their next delivery from central, so nothing changes until then.
--
-- The index keeps its name, since the group key leads it and every lookup of a
-- group's bills still uses it. It is dropped and made again here because an
-- index can't take columns after it is made. 0100 isn't edited.
--
-- ANALYZE gives the planner the new index's statistics.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
DROP INDEX idx_bills_group_key;
CREATE INDEX idx_bills_group_key ON bills(group_key, status, status_stage, state, session, year_start, relevance_score)
  WHERE group_key IS NOT NULL;

ANALYZE;
