-- Which source wrote each bill, session and person, and one table for the raw
-- records of every direct source (see docs/internal/direct-sources.md).
--
-- Until now the source was implied by the id: LIMS rows sit in reserved ranges
-- (src/lib/lims-ids.ts), and code tested the range before calling LegiScan.
-- The column replaces those tests, so a new source needs no range of its own.
-- Existing LIMS rows are backfilled from the same ranges.
--
-- source_records takes over from lims_records, whose rows are copied here.
-- lims_records stays until no deployed code reads it, and a later migration
-- drops it.
--
-- Numbered 0025 because deployments running the DC calendar and directory
-- drafts have already applied 0021 to 0024.

ALTER TABLE bills ADD COLUMN source TEXT NOT NULL DEFAULT 'legiscan';
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'legiscan';
ALTER TABLE people ADD COLUMN source TEXT NOT NULL DEFAULT 'legiscan';

UPDATE bills SET source = 'lims' WHERE bill_id >= 1000000000 AND bill_id < 2000000000;
UPDATE sessions SET source = 'lims' WHERE session_id >= 1000000000 AND session_id < 2000000000;
UPDATE people SET source = 'lims' WHERE people_id >= 1000000000 AND people_id < 2000000000;

CREATE INDEX IF NOT EXISTS idx_people_source ON people(source);

-- The raw record a direct-source bill was last built from, and its hash (the
-- change signal: none of these sources has a modified-since filter).
-- details_fetched_at drives the refresh of sources whose per-bill details can
-- change while the list record does not (LIMS LegislationDetails).
CREATE TABLE IF NOT EXISTS source_records (
  bill_id            INTEGER PRIMARY KEY,
  source             TEXT NOT NULL,
  native_key         TEXT NOT NULL,
  session_id         INTEGER NOT NULL,
  raw_json           TEXT NOT NULL,
  raw_hash           TEXT NOT NULL,
  details_fetched_at TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_records_native ON source_records(source, native_key);
CREATE INDEX IF NOT EXISTS idx_source_records_session ON source_records(session_id);

INSERT OR IGNORE INTO source_records (bill_id, source, native_key, session_id, raw_json, raw_hash, details_fetched_at, updated_at)
  SELECT bill_id, 'lims', legislation_number, 1000000000 + council_period_id, bulk_json, bulk_hash, details_fetched_at, updated_at
  FROM lims_records;
