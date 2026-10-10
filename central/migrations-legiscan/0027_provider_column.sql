-- Calls the column and tables that record a row's provider what the code and
-- the glossary call them (CONTEXT.md, Provider). 0025 added the column as
-- `source`, and 0025 and 0026 named their tables after it. A rename keeps
-- every value, the 'legiscan' default, and the backfilled LIMS rows as they
-- are.
--
-- Every upgrade path reaches this file with 0025 and 0026 applied: a fresh
-- central, a LegiScan-only central at main's migrations (through
-- 0021_session_votes_dataset), and a downstream fork's production (its own
-- 0020_lims_records and 0021 to 0024 council_* tables). So every table and
-- column named here exists, and no view or trigger refers to them.
--
-- SQLite can't rename an index, so each index named after the old column or
-- tables is dropped and created again under its new name.

ALTER TABLE bills RENAME COLUMN source TO provider;
ALTER TABLE sessions RENAME COLUMN source TO provider;
ALTER TABLE people RENAME COLUMN source TO provider;

DROP INDEX IF EXISTS idx_people_source;
CREATE INDEX IF NOT EXISTS idx_people_provider ON people(provider);

-- The LIMS provider reads a session's Council Period from its tag (CP26).
-- Every LIMS session row written so far carries one, but a row without it
-- would stop the LIMS sync, so give any such row the tag its id encodes.
UPDATE sessions SET session_tag = 'CP' || (session_id - 1000000000)
  WHERE provider = 'lims' AND session_tag NOT GLOB 'CP[0-9]*';

ALTER TABLE source_records RENAME TO provider_records;
ALTER TABLE provider_records RENAME COLUMN source TO provider;
DROP INDEX IF EXISTS idx_source_records_native;
DROP INDEX IF EXISTS idx_source_records_session;
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_records_native ON provider_records(provider, native_key);
CREATE INDEX IF NOT EXISTS idx_provider_records_session ON provider_records(session_id);

ALTER TABLE source_ids RENAME TO provider_ids;
ALTER TABLE provider_ids RENAME COLUMN source TO provider;
