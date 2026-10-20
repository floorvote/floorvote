-- DC Council LIMS source records.
--
-- LIMS bills are written into the ordinary LegiScan tables (bills, bill_history,
-- bill_texts, ...) under reserved ids (see src/lib/lims-ids.ts), so tenants see
-- no difference. This table keeps what those tables cannot: the raw BulkData
-- record each LIMS bill was last built from, and its hash. The LIMS sync writes
-- it, and the ingestor reads it back, adds LegislationDetails, and maps the pair to
-- a LegiScan-shaped bill. details_fetched_at drives the periodic refresh of
-- tracked bills, because LegislationDetails can change (a committee report is
-- filed, a vote is recorded) while the bulk record stays the same.
--
-- A new table only. Nothing existing reads it, so deploy order does not matter.
--
-- First numbered 0020, and renumbered when main added 0020_legiscan_limit_10k.
-- Wrangler tracks migrations by name, so a central that applied it as 0020 runs
-- it again as 0021, which IF NOT EXISTS makes a no-op.
CREATE TABLE IF NOT EXISTS lims_records (
  bill_id            INTEGER PRIMARY KEY,
  legislation_number TEXT NOT NULL UNIQUE,
  council_period_id  INTEGER NOT NULL,
  category_id        INTEGER NOT NULL,
  bulk_json          TEXT NOT NULL,
  bulk_hash          TEXT NOT NULL,
  details_fetched_at TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
