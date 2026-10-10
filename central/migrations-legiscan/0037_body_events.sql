-- Hearings without bills (#297). A legislature's own calendar of hearings,
-- roundtables, and meetings, with or without bills on the agenda, as a
-- provider publishes it (lib/bodyEvents.ts). DC's Council calendar is the
-- first. Central keeps each event under the provider's own event id, links
-- the bills on its agenda, and marks a bill's calendar entry on the same day
-- as covered by it, so instances show the hearing once.
--
-- body_events, one row per event:
--   provider, event_id  the provider that published it and its own id for it,
--                       which is the event's identity (unique together)
--   state               the state whose legislature holds it
--   kind                hearing, markup, meeting, or deadline
--                       (shared/calendarKinds.ts), set by central
--   type                the provider's own name for the event's type, such
--                       as Performance Oversight Hearing
--   date, time          the local day (YYYY-MM-DD) and time (HH:MM, or null)
--   timezone            the IANA zone of date and time
--   committee_id        the committees row of the committee holding it, or
--                       null for a full-body meeting
--   committee           that committee's name as the provider listed it
--   joint_with          the committees it is held jointly with, as listed
--   location, title, url
--   agenda_json         the agenda, as a JSON list of topics, each with the
--                       bill number the provider gives it, or null
--   event_hash          changes whenever anything shown changes
--   missed_pulls        successful pulls in a row that left the event out.
--                       Two cancel it, the rule bill calendar entries follow.
--   cancelled_at        when central cancelled it, or null while it is live.
--                       Rows are never deleted.
--
-- body_event_bills links an event to each central bill on its agenda.
--
-- New tables only, with nothing read from or copied into them here, so this
-- succeeds on any central. A fork's council_events table, if it has one, is
-- left alone.
--
-- No semicolons in these comments. The test helpers split migration files on
-- the statement terminator.
CREATE TABLE IF NOT EXISTS body_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  state         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  type          TEXT,
  date          TEXT NOT NULL,
  time          TEXT,
  timezone      TEXT,
  committee_id  INTEGER,
  committee     TEXT,
  joint_with    TEXT,
  location      TEXT,
  title         TEXT NOT NULL,
  agenda_json   TEXT NOT NULL DEFAULT '[]',
  url           TEXT,
  event_hash    TEXT NOT NULL,
  missed_pulls  INTEGER NOT NULL DEFAULT 0,
  cancelled_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_body_events_provider_event ON body_events(provider, event_id);
CREATE INDEX IF NOT EXISTS idx_body_events_state_date ON body_events(state, date);

CREATE TABLE IF NOT EXISTS body_event_bills (
  body_event_id INTEGER NOT NULL,
  bill_id       INTEGER NOT NULL,
  PRIMARY KEY (body_event_id, bill_id)
);
CREATE INDEX IF NOT EXISTS idx_body_event_bills_bill ON body_event_bills(bill_id);
