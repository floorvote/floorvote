-- One profile per superadmin email, kept here and carried to every instance in
-- the sign-in token. Emails are stored lowercase.
--
-- admin_sessions.name (added in 0008) is no longer read or written by the code.
-- It stays for now, defaulted to the empty string, so the previous Worker keeps
-- working while migrations run ahead of the Worker deploy. A later migration
-- can drop it.
CREATE TABLE superadmin_profiles (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
