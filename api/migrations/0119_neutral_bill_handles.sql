-- Release 2 of the neutral bill handle rename (#305, #647). A stored handle
-- legiscan:<n> becomes bill:<n>, which names central's bill <n> without naming
-- a provider. shared/billHandle.ts stores the neutral form from this release on,
-- and both spellings have parsed and been looked up since release 1.
--
-- Only a well-formed handle moves: the prefix, then a positive integer with no
-- leading zero and nothing after it (what parseHandle accepts). A malformed
-- value, an ocd-bill id, and a draft's NULL stay as they are.
--
-- Bill ids don't change, so notes, votes, comments, texts, and calendar entries
-- stay on their bills. calendar_events.uid is not touched: hearing UIDs keep the
-- legacy form for good, so subscribers' calendars never churn. Nor is
-- bills.text_r2_key, which names an object in central's bucket.
--
-- Safe to run twice: a second run finds no legacy handle to move.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.

-- A bill held under both spellings (duplicated before release 1) keeps its
-- legacy row as it is, so the unique index on external_id holds. Deliveries
-- update the neutral row (lib/storedHandle.ts).
UPDATE bills SET external_id = 'bill:' || substr(external_id, 10)
WHERE external_id GLOB 'legiscan:[1-9]*'
  AND substr(external_id, 10) NOT GLOB '*[^0-9]*'
  AND NOT EXISTS (SELECT 1 FROM bills b2 WHERE b2.external_id = 'bill:' || substr(bills.external_id, 10));

-- Identical links: write each link's neutral spelling, keeping one row where a
-- link is already held under another spelling (the primary key), then remove
-- every link that still names a well-formed legacy handle at either end.
INSERT OR IGNORE INTO bill_identical_links (external_id, companion_external_id)
SELECT
  CASE WHEN external_id GLOB 'legiscan:[1-9]*' AND substr(external_id, 10) NOT GLOB '*[^0-9]*'
    THEN 'bill:' || substr(external_id, 10) ELSE external_id END,
  CASE WHEN companion_external_id GLOB 'legiscan:[1-9]*' AND substr(companion_external_id, 10) NOT GLOB '*[^0-9]*'
    THEN 'bill:' || substr(companion_external_id, 10) ELSE companion_external_id END
FROM bill_identical_links
WHERE (external_id GLOB 'legiscan:[1-9]*' AND substr(external_id, 10) NOT GLOB '*[^0-9]*')
   OR (companion_external_id GLOB 'legiscan:[1-9]*' AND substr(companion_external_id, 10) NOT GLOB '*[^0-9]*');

DELETE FROM bill_identical_links
WHERE (external_id GLOB 'legiscan:[1-9]*' AND substr(external_id, 10) NOT GLOB '*[^0-9]*')
   OR (companion_external_id GLOB 'legiscan:[1-9]*' AND substr(companion_external_id, 10) NOT GLOB '*[^0-9]*');
