-- LegiScan cut its free tier from 30,000 to 10,000 calls/month on
-- October 1, 2026. 0010 seeded legiscan_monthly_limit at the old 30,000, so the
-- dashboard overstated the budget on any central that never changed it.
--
-- Only rewrite the untouched seed value: a central already set to its own plan
-- (paid tier, or already corrected by hand) keeps its value.
UPDATE settings
SET value = '10000', updated_at = datetime('now')
WHERE key = 'legiscan_monthly_limit' AND value = '30000';
