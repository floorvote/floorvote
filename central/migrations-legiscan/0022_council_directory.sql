-- DC Council committees and staff, from dccouncil.gov (lib/dccouncil-directory.ts).
-- LIMS has no committee membership, chairs, or staff, so these come from the
-- Council's own website. They are public work contacts. The sync replaces
-- the rows after each successful fetch.
CREATE TABLE council_committees (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  chair_json    TEXT,
  members_json  TEXT NOT NULL DEFAULT '[]',
  staff_json    TEXT NOT NULL DEFAULT '[]',
  agencies_json TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE council_directory (
  entry_key  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  title      TEXT,
  office     TEXT,
  email      TEXT,
  phone      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
