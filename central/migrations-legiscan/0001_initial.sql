-- central/migrations-legiscan/0001_initial.sql

CREATE TABLE IF NOT EXISTS sessions (
  session_id    INTEGER PRIMARY KEY,
  state         TEXT NOT NULL,
  state_id      INTEGER NOT NULL,
  year_start    INTEGER NOT NULL,
  year_end      INTEGER NOT NULL,
  prefile       INTEGER NOT NULL DEFAULT 0,
  sine_die      INTEGER NOT NULL DEFAULT 0,
  prior         INTEGER NOT NULL DEFAULT 0,
  special       INTEGER NOT NULL DEFAULT 0,
  session_tag   TEXT NOT NULL DEFAULT '',
  session_title TEXT NOT NULL,
  session_name  TEXT NOT NULL,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS people (
  people_id      INTEGER PRIMARY KEY,
  person_hash    TEXT,
  state_id       INTEGER,
  party_id       TEXT,
  party          TEXT,
  role_id        INTEGER,
  role           TEXT,
  name           TEXT NOT NULL,
  first_name     TEXT,
  middle_name    TEXT,
  last_name      TEXT,
  suffix         TEXT,
  nickname       TEXT,
  district       TEXT,
  ftm_eid        INTEGER,
  votesmart_id   INTEGER,
  opensecrets_id TEXT,
  knowwho_pid    INTEGER,
  ballotpedia    TEXT,
  bioguide_id    TEXT,
  bio_json       TEXT
);

CREATE TABLE IF NOT EXISTS bills (
  bill_id               INTEGER PRIMARY KEY,
  change_hash           TEXT NOT NULL,
  session_id            INTEGER NOT NULL,
  state                 TEXT NOT NULL,
  state_id              INTEGER NOT NULL,
  bill_number           TEXT NOT NULL,
  bill_type             TEXT NOT NULL DEFAULT 'B',
  bill_type_id          TEXT NOT NULL DEFAULT '1',
  body                  TEXT NOT NULL DEFAULT '',
  body_id               INTEGER NOT NULL DEFAULT 0,
  current_body          TEXT NOT NULL DEFAULT '',
  current_body_id       INTEGER NOT NULL DEFAULT 0,
  title                 TEXT NOT NULL,
  description           TEXT,
  status                INTEGER NOT NULL DEFAULT 1,
  status_date           TEXT,
  completed             INTEGER NOT NULL DEFAULT 0,
  pending_committee_id  INTEGER,
  url                   TEXT,
  state_link            TEXT,
  progress_json         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bills_session ON bills(session_id);
CREATE INDEX IF NOT EXISTS idx_bills_state   ON bills(state);

CREATE TABLE IF NOT EXISTS committees (
  committee_id INTEGER PRIMARY KEY,
  state        TEXT NOT NULL,
  session_id   INTEGER NOT NULL,
  chamber      TEXT NOT NULL DEFAULT '',
  chamber_id   INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bill_referrals (
  id           TEXT PRIMARY KEY,
  bill_id      INTEGER NOT NULL,
  date         TEXT NOT NULL,
  committee_id INTEGER,
  chamber      TEXT,
  chamber_id   INTEGER,
  name         TEXT
);
CREATE INDEX IF NOT EXISTS idx_bill_referrals_bill ON bill_referrals(bill_id);

CREATE TABLE IF NOT EXISTS bill_history (
  id         TEXT PRIMARY KEY,
  bill_id    INTEGER NOT NULL,
  date       TEXT NOT NULL,
  action     TEXT NOT NULL,
  chamber    TEXT,
  chamber_id INTEGER,
  importance INTEGER NOT NULL DEFAULT 1,
  seq        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_history_bill ON bill_history(bill_id);

CREATE TABLE IF NOT EXISTS bill_sponsors (
  id               TEXT PRIMARY KEY,
  bill_id          INTEGER NOT NULL,
  people_id        INTEGER,
  sponsor_type_id  INTEGER NOT NULL DEFAULT 1,
  sponsor_order    INTEGER NOT NULL DEFAULT 0,
  committee_sponsor INTEGER NOT NULL DEFAULT 0,
  committee_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bill_sponsors_bill ON bill_sponsors(bill_id);

CREATE TABLE IF NOT EXISTS bill_sasts (
  id               TEXT PRIMARY KEY,
  bill_id          INTEGER NOT NULL,
  type_id          INTEGER NOT NULL,
  type             TEXT NOT NULL,
  sast_bill_number TEXT NOT NULL,
  sast_bill_id     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_sasts_bill ON bill_sasts(bill_id);

CREATE TABLE IF NOT EXISTS bill_subjects (
  id           TEXT PRIMARY KEY,
  bill_id      INTEGER NOT NULL,
  subject_id   INTEGER NOT NULL,
  subject_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bill_subjects_bill ON bill_subjects(bill_id);

CREATE TABLE IF NOT EXISTS bill_texts (
  doc_id         INTEGER PRIMARY KEY,
  bill_id        INTEGER NOT NULL,
  date           TEXT NOT NULL,
  type           TEXT NOT NULL,
  type_id        INTEGER NOT NULL DEFAULT 1,
  mime           TEXT NOT NULL DEFAULT 'text/html',
  mime_id        INTEGER NOT NULL DEFAULT 1,
  url            TEXT,
  state_link     TEXT,
  text_size      INTEGER,
  text_hash      TEXT,
  alt_bill_text  INTEGER NOT NULL DEFAULT 0,
  alt_mime       TEXT,
  alt_mime_id    INTEGER,
  alt_state_link TEXT,
  alt_text_size  INTEGER,
  alt_text_hash  TEXT,
  r2_key         TEXT
);
CREATE INDEX IF NOT EXISTS idx_bill_texts_bill ON bill_texts(bill_id);

CREATE TABLE IF NOT EXISTS bill_supplements (
  supplement_id   INTEGER PRIMARY KEY,
  bill_id         INTEGER NOT NULL,
  date            TEXT,
  type_id         INTEGER,
  type            TEXT,
  title           TEXT,
  description     TEXT,
  mime            TEXT,
  mime_id         INTEGER,
  url             TEXT,
  state_link      TEXT,
  supplement_size INTEGER,
  supplement_hash TEXT,
  r2_key          TEXT
);
CREATE INDEX IF NOT EXISTS idx_bill_supplements_bill ON bill_supplements(bill_id);

CREATE TABLE IF NOT EXISTS bill_calendar (
  id          TEXT PRIMARY KEY,
  bill_id     INTEGER NOT NULL,
  type_id     INTEGER,
  event_hash  TEXT,
  type        TEXT,
  date        TEXT,
  time        TEXT,
  location    TEXT,
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_bill_calendar_bill ON bill_calendar(bill_id);

CREATE TABLE IF NOT EXISTS roll_calls (
  roll_call_id INTEGER PRIMARY KEY,
  bill_id      INTEGER NOT NULL,
  date         TEXT NOT NULL,
  description  TEXT,
  yea          INTEGER NOT NULL DEFAULT 0,
  nay          INTEGER NOT NULL DEFAULT 0,
  nv           INTEGER NOT NULL DEFAULT 0,
  absent       INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  passed       INTEGER NOT NULL DEFAULT 0,
  chamber      TEXT,
  chamber_id   INTEGER,
  url          TEXT,
  state_link   TEXT
);
CREATE INDEX IF NOT EXISTS idx_roll_calls_bill ON roll_calls(bill_id);

CREATE TABLE IF NOT EXISTS roll_call_votes (
  id           TEXT PRIMARY KEY,
  roll_call_id INTEGER NOT NULL,
  people_id    INTEGER,
  vote_id      INTEGER,
  vote_text    TEXT
);
CREATE INDEX IF NOT EXISTS idx_roll_call_votes_rc ON roll_call_votes(roll_call_id);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  api_url        TEXT,
  state_coverage TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  registered_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT
);

CREATE TABLE IF NOT EXISTS keyword_registry (
  tenant_id TEXT NOT NULL,
  keyword   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, keyword)
);

CREATE TABLE IF NOT EXISTS bill_tenants (
  bill_id     INTEGER NOT NULL,
  tenant_id   TEXT NOT NULL,
  notified_at TEXT,
  PRIMARY KEY (bill_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS api_call_log (
  date       TEXT NOT NULL PRIMARY KEY,
  call_count INTEGER NOT NULL DEFAULT 0
);
