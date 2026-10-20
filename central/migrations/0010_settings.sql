-- 0010_settings.sql
-- Global singleton settings (limits + latest Resend readings) for the admin dashboard.
-- Key/value store. Cron schedule is intentionally NOT here (it's per-session row data).

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed defaults. resend_monthly_limit is a placeholder plan value — confirm against
-- the live Resend tier before relying on it.
INSERT INTO settings (key, value) VALUES
  ('legiscan_monthly_limit', '30000'),
  ('resend_monthly_limit',   '50000'),
  ('resend_daily_limit',     ''),
  ('resend_monthly_used',    '0'),
  ('resend_daily_used',      '0'),
  ('resend_used_at',         ''),
  ('resend_last_429_at',     '');
