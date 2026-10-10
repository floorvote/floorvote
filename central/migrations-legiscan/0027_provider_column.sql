-- Calls the column and tables that record a row's provider what the code and
-- the glossary call them (CONTEXT.md, Provider). 0025 added the column as
-- `source`, and 0025 and 0026 named their tables after it. A rename keeps
-- every value, the 'legiscan' default, and the backfilled LIMS rows as they
-- are.
--
-- Both upgrade paths reach this file with 0025 and 0026 applied: a fresh
-- central, and a downstream fork's production (which has lims_records and
-- council_* tables of its own). So every table and column named here exists,
-- and no view or trigger refers to them.
--
-- SQLite can't rename an index, so each index named after the old column or
-- tables is dropped and created again under its new name.

ALTER TABLE bills RENAME COLUMN source TO provider;
ALTER TABLE sessions RENAME COLUMN source TO provider;
ALTER TABLE people RENAME COLUMN source TO provider;
DROP INDEX IF EXISTS idx_people_source;
CREATE INDEX IF NOT EXISTS idx_people_provider ON people(provider);

ALTER TABLE source_records RENAME TO provider_records;
ALTER TABLE provider_records RENAME COLUMN source TO provider;
DROP INDEX IF EXISTS idx_source_records_native;
DROP INDEX IF EXISTS idx_source_records_session;
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_records_native ON provider_records(provider, native_key);
CREATE INDEX IF NOT EXISTS idx_provider_records_session ON provider_records(session_id);

ALTER TABLE source_ids RENAME TO provider_ids;
ALTER TABLE provider_ids RENAME COLUMN source TO provider;
