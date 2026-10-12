-- One profile per superadmin email, kept here and carried to every instance in
-- the sign-in token. Emails are stored lowercase.
CREATE TABLE superadmin_profiles (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The per-session name added in 0008 was only ever echoed back by /auth/me and
-- never displayed. The profile above replaces it.
ALTER TABLE admin_sessions DROP COLUMN name;
