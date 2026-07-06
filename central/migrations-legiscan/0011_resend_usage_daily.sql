-- 0011_resend_usage_daily.sql
-- Daily snapshot of account-wide Resend usage (monthly-used is itself cumulative
-- within the Resend billing month). One row per UTC date, latest reading wins.
-- Enables the cumulative Budget chart for Resend (forward-only, not backfillable).

CREATE TABLE resend_usage_daily (
  date         TEXT PRIMARY KEY,
  monthly_used INTEGER NOT NULL,
  daily_used   INTEGER NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
