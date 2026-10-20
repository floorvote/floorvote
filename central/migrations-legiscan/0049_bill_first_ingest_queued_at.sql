-- 0049_bill_first_ingest_queued_at.sql
-- When a sync pass last queued a bill's first full ingest under a provider's ingestAll
-- (#835). The ingestor clears it when that message runs, and counts the try then, so a
-- bill still waiting in the queue is neither queued again nor given up on. Passes cap
-- the bills waiting this way at the provider's perPass (cron/sync.ts). NULL means none
-- waits, as for every bill before this migration.
ALTER TABLE bills ADD COLUMN first_ingest_queued_at TEXT;

-- Until now a try was counted when a pass queued the bill, so a bill whose message
-- waited behind a long queue used its tries without its ingest ever running. Start
-- the never-ingested bills over.
UPDATE bills SET first_ingest_tries = NULL
WHERE first_ingest_tries IS NOT NULL AND texts_fetched_at IS NULL AND detail_hash IS NULL;

-- The passes count a provider's waiting bills.
CREATE INDEX IF NOT EXISTS idx_bills_first_ingest_queued ON bills(provider, first_ingest_queued_at)
WHERE first_ingest_queued_at IS NOT NULL;
