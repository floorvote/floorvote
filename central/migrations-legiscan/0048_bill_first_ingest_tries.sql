-- 0048_bill_first_ingest_tries.sql
-- How many sync passes have queued a bill for its first full ingest under a provider's
-- ingestAll (#835) without one landing. Passes take untried bills first, and after three
-- tries a bill is given up on and gets monitor stubs again, so a bill whose ingest keeps
-- failing neither holds a slot every pass nor freezes its status (cron/sync.ts).
-- NULL means never queued that way. Nullable with no default, so multi-row inserts don't
-- bind one more parameter per row.
ALTER TABLE bills ADD COLUMN first_ingest_tries INTEGER;
