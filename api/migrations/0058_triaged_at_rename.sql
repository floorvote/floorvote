-- Rename the triage-dismiss latch columns to a neutral triaged_at / triaged_by.
-- Any triage action now latches a match as triaged: dismiss OR setting a priority.
ALTER TABLE bills RENAME COLUMN triage_dismissed_at TO triaged_at;
ALTER TABLE bills RENAME COLUMN triage_dismissed_by TO triaged_by;

-- Start the New-matches clock at zero on every instance. Treat everything that
-- exists at deploy time as already triaged, so only bills matched after this
-- deploy surface as new. This intentionally clears the current worklist.
UPDATE bills
   SET triaged_at = datetime('now')
 WHERE match_type = 'keyword'
   AND triaged_at IS NULL;
