-- Per-user opt-in for the weekly week-ahead email.
ALTER TABLE users ADD COLUMN email_week_ahead_enabled INTEGER NOT NULL DEFAULT 1;
