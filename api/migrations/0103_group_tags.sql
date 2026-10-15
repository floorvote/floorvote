-- Group tags (#537). Since the bill list shows one row per companion group
-- (#379), a tag filter matches a bill when its group's current analysis has
-- the tag. The current analysis is the most recently analyzed bill's, so a
-- stale tag on a replaced bill never matches. Reading that bill for every bill
-- tested made the tag filter half again as slow.
--
-- bills.group_tags stores, on every bill, the tags of its group's current
-- analysis, or the bill's own tags when it is in no group. A tag filter tests
-- this one column, as it tested tags before groups. The current analysis is
-- the group's bill with the latest ai_processed_at among those with any
-- analysis (a time, a team summary, or tags), the larger id breaking a tie,
-- as lib/teamFields.ts reads it for the bill page. A group with no analysis
-- has no tags.
--
-- Triggers keep the column right, in the same statement as the write that
-- changes it, whichever write that is: an analysis, a group forming, splitting,
-- or rekeyed by the recompute batch, a bill added or deleted. A change to a
-- bill's tags, analysis time, summary, or group key recomputes its group, and
-- its old group when it moved. The recompute writes only group_tags, so it
-- fires no trigger again.
--
-- idx_bills_group_tags holds only the bills with group tags, a few percent of
-- an instance's bills. A tag filter or tag facet names that condition, so it
-- starts from them, not from every bill. ANALYZE gives the planner its size.
--
-- No semicolons in these comments, as in every migration. Wrangler ends a
-- CREATE TRIGGER at the first END that follows a semicolon and is followed by
-- one, with whitespace between, and the test helpers split this file the
-- same way (shared/sqlStatements.ts).
ALTER TABLE bills ADD COLUMN group_tags TEXT NOT NULL DEFAULT '[]';

UPDATE bills SET group_tags = CASE WHEN group_key IS NULL THEN tags
  ELSE COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
    AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
    ORDER BY COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]') END
WHERE group_key IS NOT NULL OR tags <> '[]';

CREATE TRIGGER bills_group_tags_insert AFTER INSERT ON bills
WHEN NEW.group_key IS NOT NULL OR NEW.group_tags IS NOT NEW.tags
BEGIN
  UPDATE bills SET group_tags = CASE WHEN group_key IS NULL THEN tags
    ELSE COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]') END
  WHERE id = NEW.id OR group_key = NEW.group_key;
END;

CREATE TRIGGER bills_group_tags_update AFTER UPDATE OF tags, ai_processed_at, tenant_summary, group_key ON bills
WHEN NEW.tags IS NOT OLD.tags OR NEW.ai_processed_at IS NOT OLD.ai_processed_at
  OR NEW.tenant_summary IS NOT OLD.tenant_summary OR NEW.group_key IS NOT OLD.group_key
BEGIN
  UPDATE bills SET group_tags = CASE WHEN group_key IS NULL THEN tags
    ELSE COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]') END
  WHERE id = NEW.id OR group_key = NEW.group_key OR group_key = OLD.group_key;
END;

CREATE TRIGGER bills_group_tags_delete AFTER DELETE ON bills
WHEN OLD.group_key IS NOT NULL
BEGIN
  UPDATE bills SET group_tags = COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]')
  WHERE group_key = OLD.group_key;
END;

CREATE INDEX idx_bills_group_tags ON bills(group_key) WHERE group_tags <> '[]';

ANALYZE bills;
