-- Each bill's common stage and status rank, which central now sends with its
-- status label (from the provider's vocabulary). The bill list filters on the
-- stage and sorts status by rank, in place of a hand-written CASE over status
-- strings that only knew LegiScan's.
--
-- Backfilled from the status strings bills hold today. Those are LegiScan
-- labels, bare LegiScan codes (7 to 12, the progress events central had no
-- label for, which the web app decodes), and on a fork running DC on LIMS,
-- LIMS status names. The ranks are the ones central sends, so the status sort
-- keeps its order: Draft, Pre-filed, Introduced, Referred, Report DNP, Report
-- Pass, Engrossed, Enrolled, Failed, Vetoed, Passed, Override, Chaptered, with
-- anything else at 0 below them all. Drafts and unknown strings get no stage.
-- The next ingest of each bill writes what central sends.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE bills ADD COLUMN status_stage TEXT;
ALTER TABLE bills ADD COLUMN status_rank INTEGER NOT NULL DEFAULT 0;

UPDATE bills SET
  status_stage = CASE status
    WHEN '12' THEN 'introduced'
    WHEN 'Pre-filed' THEN 'introduced'
    WHEN '0' THEN 'introduced'
    WHEN 'Introduced' THEN 'introduced'
    WHEN '1' THEN 'introduced'
    WHEN '9' THEN 'in_committee'
    WHEN '11' THEN 'in_committee'
    WHEN '10' THEN 'in_committee'
    WHEN 'Engrossed' THEN 'passed_one_chamber'
    WHEN '2' THEN 'passed_one_chamber'
    WHEN 'Enrolled' THEN 'passed'
    WHEN '3' THEN 'passed'
    WHEN 'Failed' THEN 'failed'
    WHEN '6' THEN 'failed'
    WHEN 'Vetoed' THEN 'vetoed'
    WHEN '5' THEN 'vetoed'
    WHEN 'Passed' THEN 'enacted'
    WHEN '4' THEN 'enacted'
    WHEN '7' THEN 'enacted'
    WHEN '8' THEN 'enacted'
    WHEN 'New' THEN 'introduced'
    WHEN 'Under Council Review' THEN 'in_committee'
    WHEN 'Under Mayoral Review' THEN 'passed'
    WHEN 'Tabled' THEN 'failed'
    WHEN 'Postponed Indefinitely' THEN 'failed'
    WHEN 'Withdrawn' THEN 'failed'
    WHEN 'Disapproved' THEN 'failed'
    WHEN 'Deemed Disapproved' THEN 'failed'
    WHEN 'Expired' THEN 'failed'
    WHEN 'Approved' THEN 'enacted'
    WHEN 'Deemed Approved' THEN 'enacted'
    WHEN 'Enacted' THEN 'enacted'
    WHEN 'Under Congressional Review' THEN 'enacted'
    WHEN 'Official Law' THEN 'enacted'
    ELSE NULL
  END,
  status_rank = CASE status
    WHEN '12' THEN 101
    WHEN 'Pre-filed' THEN 102
    WHEN '0' THEN 102
    WHEN 'Introduced' THEN 103
    WHEN '1' THEN 103
    WHEN '9' THEN 201
    WHEN '11' THEN 202
    WHEN '10' THEN 203
    WHEN 'Engrossed' THEN 301
    WHEN '2' THEN 301
    WHEN 'Enrolled' THEN 401
    WHEN '3' THEN 401
    WHEN 'Failed' THEN 501
    WHEN '6' THEN 501
    WHEN 'Vetoed' THEN 601
    WHEN '5' THEN 601
    WHEN 'Passed' THEN 701
    WHEN '4' THEN 701
    WHEN '7' THEN 702
    WHEN '8' THEN 703
    WHEN 'New' THEN 101
    WHEN 'Under Council Review' THEN 201
    WHEN 'Under Mayoral Review' THEN 401
    WHEN 'Tabled' THEN 501
    WHEN 'Postponed Indefinitely' THEN 502
    WHEN 'Withdrawn' THEN 503
    WHEN 'Disapproved' THEN 505
    WHEN 'Deemed Disapproved' THEN 506
    WHEN 'Expired' THEN 507
    WHEN 'Approved' THEN 701
    WHEN 'Deemed Approved' THEN 702
    WHEN 'Enacted' THEN 703
    WHEN 'Under Congressional Review' THEN 704
    WHEN 'Official Law' THEN 705
    ELSE 0
  END;

-- The stage facet groups by it, like the status, state, and session facets.
CREATE INDEX IF NOT EXISTS idx_bills_status_stage ON bills(status_stage);

ANALYZE;
