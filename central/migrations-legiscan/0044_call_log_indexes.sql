-- 0044_call_log_indexes.sql
-- Indexes for the two append-only logs the dashboard reads, so the States page,
-- the Budget page, the sync ticks, and the daily retention job (which deletes
-- rows past CALL_LOG_RETENTION_DAYS in src/lib/pruneCallLogs.ts) read a slice
-- of each table instead of all of it. Neither table had any index beyond its id.
-- Every statement is IF NOT EXISTS, so this is safe to re-run and to apply over
-- rows already there; building an index leaves the rows alone.

-- Every api_call_log reader filters on logged_at (this month, the last 90 days,
-- the prune cutoff), and the ones that count group by call_type, which the index
-- also holds, so they never touch the table.
CREATE INDEX IF NOT EXISTS idx_api_call_log_logged_at ON api_call_log(logged_at, call_type);

-- A session's newest pass (the States page's last-pass column) and the next pass
-- after a given one (a sync tick's changes window).
CREATE INDEX IF NOT EXISTS idx_session_sync_log_session_synced ON session_sync_log(session_id, synced_at);

-- A state's newest pass (the Sync page's staleness check).
CREATE INDEX IF NOT EXISTS idx_session_sync_log_state_synced ON session_sync_log(state, synced_at);

-- The newest passes overall (the sync ticks list, the Overview's last sync) and
-- the prune cutoff.
CREATE INDEX IF NOT EXISTS idx_session_sync_log_synced ON session_sync_log(synced_at);
