-- The "This wasn't me" links in an email change's old-address notices. Each
-- notice carries its own single-use token, stored here hashed. A token is
-- scoped to one member and one change: change_id is the email_changes id the
-- notice was about, kept here because that row is deleted when the change is
-- confirmed or cancelled, and the notice sent at commit has to outlive it.
--
-- Pressing the link spends every token for its change_id, so the notice at
-- request and the notice at commit cannot both alert the admins. Tokens last
-- 7 days. The addresses and requester are copied so the admin alert can name
-- them whatever became of the pending change. The event itself lives in
-- auth_events as email_change_reported (reserved by migration 0086).
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE email_change_reports (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_email_change_reports_change ON email_change_reports(change_id);
CREATE INDEX idx_email_change_reports_expires ON email_change_reports(expires_at);
