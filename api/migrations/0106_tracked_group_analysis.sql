-- A group shows its tracked bill's analysis (#554). Since #378, a companion
-- that didn't match the instance's keywords is analyzed only so its own page
-- has a summary. Under 0103's rule, its newer analysis replaced the tracked
-- bill's tags on every bill of the group. The team follows the tracked bill,
-- so its analysis wins.
--
-- The group's current analysis is now chosen among the group's bills with any
-- analysis (a time, a team summary, or tags), those with a match type (keyword
-- or manual) first, then the latest ai_processed_at, the larger id breaking a
-- tie, as lib/teamFields.ts reads it for the bill page. Only a group with no
-- tracked analysis takes the most recent of any bill's. A group with no
-- analysis has no tags, and a bill in no group has its own, as before.
--
-- This recreates 0103's three triggers with that rule, and the update trigger
-- also fires on match_type, so a bill that starts or stops matching on its own
-- moves its group's tags. The recompute still writes only group_tags, so it
-- fires no trigger again. The backfill applies the rule to every group an
-- instance already has. idx_bills_group_tags is unchanged.
--
-- No semicolons in these comments, as in every migration. Wrangler ends a
-- CREATE TRIGGER at the first END that follows a semicolon and is followed by
-- one, with whitespace between, and api/test/helpers.ts splits this file the
-- same way (splitStatements).
DROP TRIGGER IF EXISTS bills_group_tags_insert;
DROP TRIGGER IF EXISTS bills_group_tags_update;
DROP TRIGGER IF EXISTS bills_group_tags_delete;

UPDATE bills SET group_tags = COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
    AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
    ORDER BY g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]')
WHERE group_key IS NOT NULL;

CREATE TRIGGER bills_group_tags_insert AFTER INSERT ON bills
WHEN NEW.group_key IS NOT NULL OR NEW.group_tags IS NOT NEW.tags
BEGIN
  UPDATE bills SET group_tags = CASE WHEN group_key IS NULL THEN tags
    ELSE COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]') END
  WHERE id = NEW.id OR group_key = NEW.group_key;
END;

CREATE TRIGGER bills_group_tags_update AFTER UPDATE OF tags, ai_processed_at, tenant_summary, group_key, match_type ON bills
WHEN NEW.tags IS NOT OLD.tags OR NEW.ai_processed_at IS NOT OLD.ai_processed_at
  OR NEW.tenant_summary IS NOT OLD.tenant_summary OR NEW.group_key IS NOT OLD.group_key
  OR NEW.match_type IS NOT OLD.match_type
BEGIN
  UPDATE bills SET group_tags = CASE WHEN group_key IS NULL THEN tags
    ELSE COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]') END
  WHERE id = NEW.id OR group_key = NEW.group_key OR group_key = OLD.group_key;
END;

CREATE TRIGGER bills_group_tags_delete AFTER DELETE ON bills
WHEN OLD.group_key IS NOT NULL
BEGIN
  UPDATE bills SET group_tags = COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]')
  WHERE group_key = OLD.group_key;
END;
