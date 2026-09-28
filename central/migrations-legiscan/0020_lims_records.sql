-- DC Council LIMS source records.
--
-- LIMS bills are written into the ordinary LegiScan tables (bills, bill_history,
-- bill_texts, ...) under reserved ids (see src/lib/lims-ids.ts), so tenants see
-- no difference. This table keeps what those tables cannot: the raw BulkData
-- record each LIMS bill was last built from, and its hash. The LIMS sync writes
-- it, and the ingestor reads it back, adds LegislationDetails, and maps the pair to
-- a LegiScan-shaped bill.
--
-- A new table only. Nothing existing reads it, so deploy order does not matter.
CREATE TABLE IF NOT EXISTS lims_records (
  bill_id            INTEGER PRIMARY KEY,
  legislation_number TEXT NOT NULL UNIQUE,
  council_period_id  INTEGER NOT NULL,
  category_id        INTEGER NOT NULL,
  bulk_json          TEXT NOT NULL,
  bulk_hash          TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
