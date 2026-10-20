-- Index bill_calendar(date) so the /tenants/:id/upcoming-hearings date-range
-- filter (WHERE bc.date BETWEEN ? AND ?) is an indexed range scan instead of a
-- full table scan. Without it, every call scanned the whole table; combined
-- with an unscoped monitor-all tenant that drove the July 2026 central-bills-ls
-- rows-read spike (1M -> 490M/day). Applied manually to production 2026-07-28
-- mid-incident; this migration makes it reproducible for fresh DBs.
CREATE INDEX IF NOT EXISTS idx_bill_calendar_date ON bill_calendar(date);
