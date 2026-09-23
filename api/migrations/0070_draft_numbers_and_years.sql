-- Give existing draft bills a unique number and a year.
--
-- Until now a draft was created with bill_number = 'DRAFT' and no session or
-- year at all. That made three things break at once, all downstream of the
-- same cause: billUrl() could not build a canonical /STATE/YEAR/NUMBER so
-- drafts fell back to /bills/<uuid>, the bill row printed two chips that both
-- said Draft (the badge showing the literal bill_number, plus the isDraft
-- pill), and a yearless bill sorted below every filed bill.
--
-- Numbers are D1..Dn per state, ordered by created_at. The year is taken from
-- the newest filed bill in the same state, which is this tenant's current
-- session. Deliberately NOT fetched from central: a migration must be
-- self-contained and reproducible offline. New drafts get a better default
-- from GET /bills/draft-defaults, which does consult central.
--
-- Existing /bills/<uuid> links keep working -- the uuid route is untouched.
-- These rows simply gain a canonical URL they did not have.

UPDATE bills
SET bill_number = 'D' || (
  SELECT COUNT(*) FROM bills AS earlier
  WHERE earlier.is_draft = 1
    AND earlier.state = bills.state
    AND (earlier.created_at < bills.created_at
         OR (earlier.created_at = bills.created_at AND earlier.id <= bills.id))
)
WHERE is_draft = 1;

UPDATE bills
SET year_start = COALESCE(
      (SELECT MAX(filed.year_end) FROM bills AS filed
       WHERE filed.is_draft = 0 AND filed.state = bills.state
         AND filed.year_end IS NOT NULL),
      CAST(strftime('%Y', 'now') AS INTEGER)
    )
WHERE is_draft = 1 AND year_start IS NULL;

UPDATE bills
SET year_end = year_start
WHERE is_draft = 1 AND year_end IS NULL;
