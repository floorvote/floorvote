-- 0045_session_sync_log_status.sql
-- A pass that failed gets a row in session_sync_log, so the States page can show
-- it as failed instead of showing the pass before it (or "No pass logged").
-- `status` is 'ok' for a pass that finished, which is every row logged before this
-- migration and every LegiScan pass (those writes name no status), and 'failed'
-- for a snapshot provider's pass that threw. `error` is the error's message,
-- truncated by the writer, and is NULL for a pass that finished.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS: wrangler applies each migration once,
-- and the existing rows take the default, so nothing is rewritten by hand.

ALTER TABLE session_sync_log ADD COLUMN status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed'));
ALTER TABLE session_sync_log ADD COLUMN error TEXT;
