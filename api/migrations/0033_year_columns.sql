ALTER TABLE bills ADD COLUMN year_start INTEGER;
ALTER TABLE bills ADD COLUMN year_end INTEGER;

-- Backfill sessions whose names start with a 4-digit year (2000–2099).
-- Handles "2026 Regular Session", "2026-2027 Regular Session", "2025-2026 Regular Session", etc.
UPDATE bills
SET
  year_start = CAST(SUBSTR(session, 1, 4) AS INTEGER),
  year_end = CASE
    WHEN SUBSTR(session, 5, 1) = '-'
     AND SUBSTR(session, 6, 4) GLOB '[0-9][0-9][0-9][0-9]'
     AND CAST(SUBSTR(session, 6, 4) AS INTEGER) BETWEEN 2000 AND 2100
    THEN CAST(SUBSTR(session, 6, 4) AS INTEGER)
    ELSE CAST(SUBSTR(session, 1, 4) AS INTEGER)
  END
WHERE SUBSTR(session, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
  AND CAST(SUBSTR(session, 1, 4) AS INTEGER) BETWEEN 2000 AND 2100;

-- Backfill DC "26th Council" (year not derivable from name).
UPDATE bills SET year_start = 2025, year_end = 2026 WHERE session = '26th Council';
