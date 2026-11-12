-- A covering index of a bill's subject rows, for the subject counts of the facets (#1023).
--
-- The subject facet counts the subject rows of the bills that meet the filters, grouped by (state, subject name).
-- The rows are reached from the bill by bill_id, and the primary key's index (bill_id, subject_name) lacks the
-- state, so each row cost a table lookup after its index entry. On the largest instance, with 174,000 subject rows
-- for 99,466 bills, a count under a broad filter read some 540,000 rows and took about a second of D1's per-database
-- budget, and the menu request that asks for the subject and committee counts was over the budget by itself.
--
-- idx_bill_subjects_bill holds the bill, the state, and the name, so the join from a bill to its subjects reads the
-- index alone. It is about 6 MB on the largest instance, and every write of a bill's subjects also writes it. The
-- primary key and idx_bill_subjects_name (state, subject_name, which serves the whole count when nothing tests the
-- bill) stay, since other statements read them.
--
-- ANALYZE bill_subjects gives the planner the new index's statistics. It reads each index of the table once.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files on the statement terminator before it
-- strips comment lines.
CREATE INDEX IF NOT EXISTS idx_bill_subjects_bill ON bill_subjects(bill_id, state, subject_name);

ANALYZE bill_subjects;
