-- F5c: drop the now-vestigial is_stub column (and its partial index).
-- No code reads or writes the column as of F5b (commit 4b1a259b).
-- Canonical state lives in match_type + text_status + ai_processed_at.

DROP INDEX IF EXISTS idx_bills_is_stub;
ALTER TABLE bills DROP COLUMN is_stub;
