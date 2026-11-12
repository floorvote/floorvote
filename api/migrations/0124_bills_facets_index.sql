-- A covering index for the facet counts, and a wider group key index (#1019).
--
-- GET /bills/facets counts the bills that meet the request's filters, many
-- times a request: the five bill-column facets, the status groups, the
-- subject and committee counts, the holder tests of priority and position,
-- and the special scopes. Each reads a handful of bill columns and no more,
-- yet no index held them together. A count under a broad filter, one on a
-- column with no index of its own, or one a planner misjudged read the bill
-- rows themselves, a table lookup a row. On the largest instance, with a
-- hundred thousand bills, the subject and committee counts under such a
-- filter took one to three seconds each, and a few requests spent D1's
-- per-database budget so that every query in the window failed (7429 "D1 DB
-- is overloaded").
--
-- idx_bills_facets holds every column a facet count or a bill-fact condition
-- reads: status, stage, state, session, year, priority and the time it was
-- set, relevance, match type, the time of the newest match, the draft flag,
-- the group key and the group tags, the status rank, and the id. A count
-- reads it alone, and a join from the bills to their subjects or committees
-- reaches each bill's rows by key. The status leads it, as the leading column
-- of a status search. It holds every bill, about 110 bytes an entry, or
-- about 11 MB on the largest instance, and every write to one of those
-- columns now also writes it.
--
-- idx_bills_group_key, the partial index of grouped bills, gains priority,
-- the time it was set, and the group tags, so the holder tests on a bill's
-- companions (does another bill of the group hold a newer priority) and the
-- tag tests on a group read the index and not the table. An index cannot take
-- columns after it is made, so it is dropped and made again, as 0102 did.
-- 0100 and 0102 are not edited.
--
-- The single-column indexes stay (idx_bills_status, _state, _session,
-- _year_start, _status_stage, _priority). Other statements read them, and
-- which of those the facets index replaces is for a later change to measure.
--
-- COUPLING: the priority none test in lib/teamFields.ts is written
-- +priority IS NULL so that no index serves it. About 99 percent of bills
-- share that value, and the planner otherwise starts from idx_bills_priority,
-- one column, and looks up the table row for each of them, where reading this
-- index end to end is cheaper. Keep the plus.
--
-- ANALYZE bills gives the planner both indexes' statistics. It reads each
-- index once, as 0102 did.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE INDEX idx_bills_facets ON bills(status, status_stage, state, session, year_start, priority, priority_set_at, relevance_score, match_type, new_match_at, is_draft, group_key, group_tags, status_rank, id);

DROP INDEX idx_bills_group_key;
CREATE INDEX idx_bills_group_key ON bills(group_key, status, status_stage, state, session, year_start, relevance_score, priority, priority_set_at, group_tags, id)
  WHERE group_key IS NOT NULL;

ANALYZE bills;
