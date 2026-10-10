-- Bill calendar entries keep a stable identity and are never deleted (#295).
-- The ingest used to delete a bill's calendar rows and write them again, and
-- an entry missing from one pull was cancelled. Now each row stays, and
-- lib/billCalendar.ts updates it in place.
--
-- event_id      the provider's own id for the event, when it publishes one
-- identity_key  the identity instances build the entry's calendar UID from.
--               Null on every row written before this migration, which keeps
--               the identity central computed for it then (type id and
--               description), so no instance's calendar churns.
-- missed_pulls  successful pulls in a row the entry was missing from. Two
--               cancel it.
-- missed_hash   the bill's change hash in the last of those pulls. A sync pass
--               that lists the bill with the same hash counts as one more.
-- cancelled_at  when central cancelled the entry, or null while it is live
--
-- Columns only, each nullable or defaulted, so this succeeds on any existing
-- data. The partial index holds only the rows of missing entries, which each
-- sync pass reads to find bills to recheck.
--
-- No semicolons in these comments. The test helpers split migration files on
-- the statement terminator.
ALTER TABLE bill_calendar ADD COLUMN event_id TEXT;
ALTER TABLE bill_calendar ADD COLUMN identity_key TEXT;
ALTER TABLE bill_calendar ADD COLUMN missed_pulls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bill_calendar ADD COLUMN missed_hash TEXT;
ALTER TABLE bill_calendar ADD COLUMN cancelled_at TEXT;
CREATE INDEX IF NOT EXISTS idx_bill_calendar_missed ON bill_calendar(bill_id, missed_hash) WHERE missed_pulls > 0 AND cancelled_at IS NULL;
