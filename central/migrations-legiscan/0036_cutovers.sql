-- Cutovers (#296): moving a state that instances already track from one
-- provider to another without rewriting any instance (lib/cutover.ts).
--
-- cutovers        one row per cutover of a state. sessions_json holds the
--                 losing provider's sessions in the state and their prior and
--                 sine_die flags before the cutover marked them ended, so an
--                 undo can put them back. undone_at is set by an undo.
-- cutover_bills   each bill the cutover moved. It keeps its central row id
--                 (bill_id). native_key is the new provider's own key for it,
--                 which core maps to that id, and the session ids are where
--                 the bill was and where it went.
-- cutover_people  each legislator matched across the two providers. They keep
--                 their central person id (people_id), and core gives it in
--                 place of the id the new provider has for them
--                 (provider_people_id). matched_on lists what agreed, and weak
--                 is 1 when that falls short of the name, chamber, and
--                 district.
-- carried_from    on bills, the provider whose data a moved bill still holds,
--                 until its new provider's first ingest. That ingest sends
--                 instances no changes, and carries the bill's calendar entries
--                 over under the identities instances know.
--
-- New tables and one nullable column, so this succeeds on any existing data.
-- No semicolons in these comments. The test helpers split migration files on
-- the statement terminator.
CREATE TABLE IF NOT EXISTS cutovers (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  from_provider TEXT NOT NULL,
  to_provider   TEXT NOT NULL,
  sessions_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  undone_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cutovers_state ON cutovers(state, created_at);

CREATE TABLE IF NOT EXISTS cutover_bills (
  cutover_id      TEXT NOT NULL,
  bill_id         INTEGER NOT NULL,
  native_key      TEXT NOT NULL,
  from_session_id INTEGER NOT NULL,
  to_session_id   INTEGER NOT NULL,
  PRIMARY KEY (cutover_id, bill_id)
);

CREATE TABLE IF NOT EXISTS cutover_people (
  cutover_id         TEXT NOT NULL,
  people_id          INTEGER NOT NULL,
  provider_people_id INTEGER NOT NULL,
  matched_on         TEXT NOT NULL,
  weak               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cutover_id, provider_people_id)
);

ALTER TABLE bills ADD COLUMN carried_from TEXT;
