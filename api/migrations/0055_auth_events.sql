-- Append-only audit log of authentication events: magic-link requests, sends,
-- delivery outcomes, verifies, logouts, and rate-limits. Powers per-user login
-- diagnostics in the Members admin page. email_delivered/email_complained are
-- reserved for Phase 2 (CF GraphQL enrichment) so the CHECK needs no later rebuild.
CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (
    'link_requested', 'email_sent', 'email_send_failed', 'email_bounced',
    'verify_success', 'verify_failed', 'logout', 'rate_limited',
    'email_delivered', 'email_complained'
  )),
  reason TEXT,
  link_type TEXT,
  provider TEXT,
  message_id TEXT,
  user_agent TEXT,
  ip_country TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_auth_events_user_created ON auth_events(user_id, created_at);
CREATE INDEX idx_auth_events_email_created ON auth_events(email, created_at);
CREATE INDEX idx_auth_events_message ON auth_events(message_id);
