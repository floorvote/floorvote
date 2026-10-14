-- Companion groups (#376). Bills linked by identical relationships, in either
-- direction, form a group, and the team's engagement on any of them is read
-- across the whole group. Nothing moves between bills, so this adds no data
-- migration. Engagement stays on the bill where it was made.
--
-- bills.group_key is the smallest id in the bill's group, or NULL for a bill
-- with no identical companion in this instance. Reads find a group's members
-- through its index.
--
-- bill_identical_links holds each bill's identical companions as central's
-- vocabulary reads them, by bill handle on both sides, so a companion the
-- instance doesn't hold yet is remembered for when it arrives. The reverse
-- index serves the other direction of a relationship.
--
-- team_events records a group forming or splitting, one row per bill, and
-- later other team-level changes. type has no CHECK so a new kind of event
-- needs no table rebuild.
--
-- Existing bills start ungrouped. Each is grouped on its next delivery from
-- central, and a metadata refresh groups them all at once.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE bills ADD COLUMN group_key TEXT;
CREATE INDEX idx_bills_group_key ON bills(group_key) WHERE group_key IS NOT NULL;

CREATE TABLE bill_identical_links (
  external_id TEXT NOT NULL,
  companion_external_id TEXT NOT NULL,
  PRIMARY KEY (external_id, companion_external_id)
);
CREATE INDEX idx_bill_identical_links_companion ON bill_identical_links(companion_external_id);

CREATE TABLE team_events (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_user_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_team_events_bill ON team_events(bill_id, created_at);

ANALYZE;
