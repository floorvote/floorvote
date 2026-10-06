-- Record an admin changing a pending invite's address. Adds email_changed to
-- the auth_events event CHECK, and an actor_id column for the member who
-- caused an event when that is not the member it is about (the admin, for
-- email_changed, and null for every other event).
--
-- SQLite can't ALTER a CHECK, so rebuild the table. Mirrors migration 0056.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE auth_events_new (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (
    'link_requested', 'link_requested_unknown', 'email_sent', 'email_send_failed', 'email_bounced',
    'verify_success', 'verify_failed', 'logout', 'rate_limited',
    'email_delivered', 'email_complained', 'email_changed'
  )),
  reason TEXT,
  link_type TEXT,
  provider TEXT,
  message_id TEXT,
  user_agent TEXT,
  ip_country TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id TEXT
);
INSERT INTO auth_events_new (id, user_id, email, event, reason, link_type, provider, message_id, user_agent, ip_country, created_at)
  SELECT id, user_id, email, event, reason, link_type, provider, message_id, user_agent, ip_country, created_at FROM auth_events;
DROP TABLE auth_events;
ALTER TABLE auth_events_new RENAME TO auth_events;
CREATE INDEX idx_auth_events_user_created ON auth_events(user_id, created_at);
CREATE INDEX idx_auth_events_email_created ON auth_events(email, created_at);
CREATE INDEX idx_auth_events_message ON auth_events(message_id);
