-- When a tenant last asked for the bill to be fetched without tracking it (POST /tenants/fetch-bills).
-- It is only a lock on asking again. texts_fetched_at stays what the ingest stamps once a fetch succeeds,
-- so a fetch that never completes isn't read as a bill with no texts.
ALTER TABLE bills ADD COLUMN texts_requested_at TEXT;
