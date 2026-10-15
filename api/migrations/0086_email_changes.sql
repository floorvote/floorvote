-- A member's pending change of sign-in email. The change takes effect only when
-- someone confirms it from the new address, through a single-use link whose
-- token is stored here hashed. One row per member at most: a new request
-- replaces the old one, and a confirmed or cancelled change deletes its row,
-- which is what makes the token single use. The history of each step lives in
-- auth_events, not here.
--
-- requested_by is the member who asked (the member themselves, or an admin).
-- requesting_session_id is the session a self-service request came from, the
-- one session the commit leaves signed in. Null ends every session at commit.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE email_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requesting_session_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_email_changes_new_email ON email_changes(new_email);

-- Record each step of an email change in auth_events. Adds the request,
-- confirm, and cancel events, and reserves email_change_reported for the
-- old address's "This wasn't me" so that needs no later rebuild.
-- SQLite can't ALTER a CHECK, so rebuild the table. Mirrors migration 0075,
-- keeping actor_id and every index, including 0084's partial one.
CREATE TABLE auth_events_new (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (
    'link_requested', 'link_requested_unknown', 'email_sent', 'email_send_failed', 'email_bounced',
    'verify_success', 'verify_failed', 'logout', 'rate_limited',
    'email_delivered', 'email_complained', 'email_changed',
    'email_change_requested', 'email_change_confirmed', 'email_change_cancelled', 'email_change_reported'
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
INSERT INTO auth_events_new (id, user_id, email, event, reason, link_type, provider, message_id, user_agent, ip_country, created_at, actor_id)
  SELECT id, user_id, email, event, reason, link_type, provider, message_id, user_agent, ip_country, created_at, actor_id FROM auth_events;
DROP TABLE auth_events;
ALTER TABLE auth_events_new RENAME TO auth_events;
CREATE INDEX idx_auth_events_user_created ON auth_events(user_id, created_at);
CREATE INDEX idx_auth_events_email_created ON auth_events(email, created_at);
CREATE INDEX idx_auth_events_message ON auth_events(message_id);
CREATE INDEX idx_auth_events_actor_created ON auth_events(actor_id, created_at) WHERE actor_id IS NOT NULL;
