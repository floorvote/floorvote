-- 0050_bill_texts_unattempted.sql
-- The hourly missing-texts sweep (cron/missing-texts.ts) looks for texts no
-- download attempt ever reached. Most stored texts are downloaded or attempted,
-- so this index holds only the rows the sweep can pick.
CREATE INDEX IF NOT EXISTS idx_bill_texts_unattempted ON bill_texts(bill_id)
WHERE r2_key IS NULL AND fetch_attempted_at IS NULL AND state_link IS NOT NULL;
