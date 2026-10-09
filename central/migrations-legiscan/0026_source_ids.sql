-- Central ids for records from direct sources that have no integer id of their
-- own (see docs/internal/direct-sources.md). Each (source, kind, native key)
-- gets one id from a single sequence, so ids from different sources and of
-- different kinds never collide, and no source has to design an id range.
--
-- kind: bill, session, person, doc. native_key: the source's own key, such as
-- 2026RS/HB0001 for a Maryland bill.
--
-- The placeholder row starts the sequence above 3,000,000,000: clear of
-- LegiScan's ids (in the millions) and of the ranges LIMS ids are packed into
-- (1e9 to 3e9, src/lib/lims-ids.ts). LIMS keeps its own ids.
--
-- It also repeats 0025's backfill. Code deployed before 0025 that ran between
-- that migration and its own deploy wrote new LIMS rows as 'legiscan' and into
-- lims_records only, and nothing else would correct them.

CREATE TABLE IF NOT EXISTS source_ids (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  native_key TEXT NOT NULL,
  UNIQUE (source, kind, native_key)
);

INSERT OR IGNORE INTO source_ids (id, source, kind, native_key) VALUES (3000000000, '', '', '');

UPDATE bills SET source = 'lims' WHERE bill_id >= 1000000000 AND bill_id < 2000000000 AND source = 'legiscan';
UPDATE sessions SET source = 'lims' WHERE session_id >= 1000000000 AND session_id < 2000000000 AND source = 'legiscan';
UPDATE people SET source = 'lims' WHERE people_id >= 1000000000 AND people_id < 2000000000 AND source = 'legiscan';
INSERT OR IGNORE INTO source_records (bill_id, source, native_key, session_id, raw_json, raw_hash, details_fetched_at, updated_at)
  SELECT bill_id, 'lims', legislation_number, 1000000000 + council_period_id, bulk_json, bulk_hash, details_fetched_at, updated_at
  FROM lims_records;
