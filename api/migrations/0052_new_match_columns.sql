-- New keyword-match triage: set-once match timestamp + org-shared dismiss state.
ALTER TABLE bills ADD COLUMN new_match_at TEXT;
ALTER TABLE bills ADD COLUMN triage_dismissed_at TEXT;
ALTER TABLE bills ADD COLUMN triage_dismissed_by TEXT;

-- Launch backfill: start every admin's worklist EMPTY rather than dumping the
-- back-catalog. Any analyzed keyword bill that would currently be "needs review"
-- is pre-dismissed at deploy time. Only bills matched AFTER launch surface.
UPDATE bills
   SET triage_dismissed_at = datetime('now')
 WHERE match_type = 'keyword'
   AND ai_processed_at IS NOT NULL
   AND priority IS NULL
   AND triage_dismissed_at IS NULL;

-- Backfill new_match_at for completeness on already-analyzed keyword bills
-- (so the column is meaningful for history) -- falling back to created_at.
UPDATE bills
   SET new_match_at = COALESCE(ai_processed_at, created_at)
 WHERE match_type = 'keyword'
   AND ai_processed_at IS NOT NULL
   AND new_match_at IS NULL;
