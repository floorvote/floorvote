-- Group overrides (#382). An admin groups two bills by hand, or splits a bill
-- from its companion group, from the bill page's overflow menu. Each is kept
-- here as a pair of bills, and every recompute of companion groups reads them
-- with the provider's identical links: a link pair joins its two bills as an
-- identical link would, and a split pair removes any identical link between
-- its two bills. So an override takes precedence over provider data on every
-- sync, and a split stays split while the provider still says identical.
--
-- One row per pair, smaller bill id first, so a pair is either linked or split
-- and never both. Splitting a pair an admin linked, or linking a split pair,
-- replaces its row. Pairs are kept by bill id, not handle, so they hold for
-- any two bills in the instance, and go when either bill is deleted.
--
-- Nothing here writes group_key. The recompute in api/src/lib/companionGroups.ts
-- does, with an ordinary UPDATE, so 0103's triggers keep group_tags right.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE bill_group_overrides (
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  other_bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'split')),
  actor_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bill_id, other_bill_id),
  CHECK (bill_id < other_bill_id)
);
CREATE INDEX idx_bill_group_overrides_other ON bill_group_overrides(other_bill_id);
