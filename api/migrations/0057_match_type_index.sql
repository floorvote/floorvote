-- Index on match_type for the tracked-only base filter (WHERE match_type IS NOT NULL).
-- The simple index serves count(*) efficiently; the covering partial index serves
-- facet GROUP BY and sort queries without touching the main table.
CREATE INDEX IF NOT EXISTS idx_bills_match_type ON bills(match_type);

CREATE INDEX IF NOT EXISTS idx_bills_tracked_cover ON bills(
  status, priority, state, year_start, session,
  relevance_score, last_action_date
) WHERE match_type IS NOT NULL;

-- ANALYZE is required for SQLite to choose the partial index over existing full
-- indexes (idx_bills_state, idx_bills_session) when grouping tracked bills.
ANALYZE;
