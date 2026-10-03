-- Council membership over time. Seats and committees change between Council
-- Periods and within them (a resignation, an appointment, a special election,
-- a committee reorganization), so the directory keeps its history.
--
-- people.term_start and term_end are the term dates LIMS gives each member
-- (Members/{councilPeriodId}). A member whose term_end has passed is former.
ALTER TABLE people ADD COLUMN term_start TEXT;
ALTER TABLE people ADD COLUMN term_end TEXT;

-- One row per version of a committee's roster: a change closes the open row
-- (valid_to) and opens a new one, so "who chaired this committee on a date"
-- has an answer.
CREATE TABLE council_committee_history (
  slug         TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  name         TEXT NOT NULL,
  chair        TEXT,
  members_json TEXT NOT NULL DEFAULT '[]',
  staff_json   TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (slug, valid_from)
);

-- What changed, for the People page's recent changes: a member sworn in or
-- leaving, a committee chair or membership change, key staff joining or
-- leaving, a committee created or dissolved.
CREATE TABLE council_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind        TEXT NOT NULL,
  committee   TEXT,
  person      TEXT,
  detail      TEXT
);

CREATE INDEX idx_council_changes_detected ON council_changes (detected_at);
