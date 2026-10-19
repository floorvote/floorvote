-- A group shows its lead bill's analysis. The lead is the bill furthest
-- along, then the one with the newest bill text, then the lowest natural bill
-- number, then the smallest id, tracked or not, as lib/groupLead.ts picks it
-- for the list row and lib/teamFields.ts reads the group's analysis for every
-- page. Under 0106, the analysis came from the most recently analyzed tracked
-- bill, so it flipped whenever any member was analyzed again.
--
-- The group's tags are now its lead's when the lead has an analysis (a time,
-- a team summary, or tags). While it has none, they are what 0106 chose: among
-- the bills with an analysis, those with a match type first, then the latest
-- ai_processed_at, the larger id breaking a tie. A group with no analysis has
-- no tags, and a bill in no group has its own, as before.
--
-- This recreates 0106's three triggers with that rule. The update trigger also
-- fires on status_rank and bill_number, which can move the lead. Three new
-- triggers on bill_texts recompute a grouped bill's group when a text is
-- added, removed, or redated, since the newest text can move the lead too.
-- The recompute still writes only group_tags, so it fires no trigger again.
-- The backfill, after the triggers so a write between them is covered too,
-- applies the rule to every group an instance already has, and rewrites any
-- group_tags that drifted. Every trigger is dropped if it exists
-- before it is created, so running this file again leaves the same triggers
-- and tags. idx_bills_group_tags is unchanged.
--
-- The natural bill number is the text before the first digit, then the number
-- from it, as lib/groupLead.ts splits it.
--
-- No semicolons in these comments, as in every migration. Wrangler ends a
-- CREATE TRIGGER at the first END that follows a semicolon and is followed by
-- one, with whitespace between, and the test helpers split this file the
-- same way (shared/sqlStatements.ts).
DROP TRIGGER IF EXISTS bills_group_tags_insert;
DROP TRIGGER IF EXISTS bills_group_tags_update;
DROP TRIGGER IF EXISTS bills_group_tags_delete;
DROP TRIGGER IF EXISTS bill_texts_group_tags_insert;
DROP TRIGGER IF EXISTS bill_texts_group_tags_update;
DROP TRIGGER IF EXISTS bill_texts_group_tags_delete;

CREATE TRIGGER bills_group_tags_insert AFTER INSERT ON bills
WHEN NEW.group_key IS NOT NULL OR NEW.group_tags IS NOT NEW.tags
BEGIN
  UPDATE bills SET group_tags = CASE WHEN group_key IS NULL THEN tags
    ELSE COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.id = (SELECT l.id FROM bills l WHERE l.group_key = g.group_key
        ORDER BY l.status_rank DESC,
          (SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = l.id) DESC NULLS LAST,
          substr(l.bill_number, 1, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END) - 1) ASC,
          CAST(substr(l.bill_number, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END)) AS INTEGER) ASC,
          l.id ASC LIMIT 1) DESC,
        g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]') END
  WHERE id = NEW.id OR group_key = NEW.group_key;
END;

CREATE TRIGGER bills_group_tags_update AFTER UPDATE OF tags, ai_processed_at, tenant_summary, group_key, match_type, status_rank, bill_number ON bills
WHEN NEW.tags IS NOT OLD.tags OR NEW.ai_processed_at IS NOT OLD.ai_processed_at
  OR NEW.tenant_summary IS NOT OLD.tenant_summary OR NEW.group_key IS NOT OLD.group_key
  OR ((NEW.match_type IS NOT OLD.match_type OR NEW.status_rank IS NOT OLD.status_rank OR NEW.bill_number IS NOT OLD.bill_number)
    AND (NEW.group_key IS NOT NULL OR OLD.group_key IS NOT NULL))
BEGIN
  UPDATE bills SET group_tags = CASE WHEN group_key IS NULL THEN tags
    ELSE COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.id = (SELECT l.id FROM bills l WHERE l.group_key = g.group_key
        ORDER BY l.status_rank DESC,
          (SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = l.id) DESC NULLS LAST,
          substr(l.bill_number, 1, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END) - 1) ASC,
          CAST(substr(l.bill_number, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END)) AS INTEGER) ASC,
          l.id ASC LIMIT 1) DESC,
        g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]') END
  WHERE id = NEW.id OR group_key = NEW.group_key OR group_key = OLD.group_key;
END;

CREATE TRIGGER bills_group_tags_delete AFTER DELETE ON bills
WHEN OLD.group_key IS NOT NULL
BEGIN
  UPDATE bills SET group_tags = COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.id = (SELECT l.id FROM bills l WHERE l.group_key = g.group_key
        ORDER BY l.status_rank DESC,
          (SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = l.id) DESC NULLS LAST,
          substr(l.bill_number, 1, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END) - 1) ASC,
          CAST(substr(l.bill_number, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END)) AS INTEGER) ASC,
          l.id ASC LIMIT 1) DESC,
        g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]')
  WHERE group_key = OLD.group_key;
END;

CREATE TRIGGER bill_texts_group_tags_insert AFTER INSERT ON bill_texts
WHEN (SELECT group_key FROM bills WHERE id = NEW.bill_id) IS NOT NULL
BEGIN
  UPDATE bills SET group_tags = COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.id = (SELECT l.id FROM bills l WHERE l.group_key = g.group_key
        ORDER BY l.status_rank DESC,
          (SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = l.id) DESC NULLS LAST,
          substr(l.bill_number, 1, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END) - 1) ASC,
          CAST(substr(l.bill_number, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END)) AS INTEGER) ASC,
          l.id ASC LIMIT 1) DESC,
        g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]')
  WHERE group_key = (SELECT group_key FROM bills WHERE id = NEW.bill_id);
END;

CREATE TRIGGER bill_texts_group_tags_update AFTER UPDATE OF date, bill_id ON bill_texts
WHEN (NEW.date IS NOT OLD.date OR NEW.bill_id IS NOT OLD.bill_id)
  AND ((SELECT group_key FROM bills WHERE id = NEW.bill_id) IS NOT NULL OR (SELECT group_key FROM bills WHERE id = OLD.bill_id) IS NOT NULL)
BEGIN
  UPDATE bills SET group_tags = COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.id = (SELECT l.id FROM bills l WHERE l.group_key = g.group_key
        ORDER BY l.status_rank DESC,
          (SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = l.id) DESC NULLS LAST,
          substr(l.bill_number, 1, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END) - 1) ASC,
          CAST(substr(l.bill_number, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END)) AS INTEGER) ASC,
          l.id ASC LIMIT 1) DESC,
        g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]')
  WHERE group_key IN (SELECT group_key FROM bills WHERE id IN (NEW.bill_id, OLD.bill_id));
END;

CREATE TRIGGER bill_texts_group_tags_delete AFTER DELETE ON bill_texts
WHEN (SELECT group_key FROM bills WHERE id = OLD.bill_id) IS NOT NULL
BEGIN
  UPDATE bills SET group_tags = COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.id = (SELECT l.id FROM bills l WHERE l.group_key = g.group_key
        ORDER BY l.status_rank DESC,
          (SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = l.id) DESC NULLS LAST,
          substr(l.bill_number, 1, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END) - 1) ASC,
          CAST(substr(l.bill_number, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END)) AS INTEGER) ASC,
          l.id ASC LIMIT 1) DESC,
        g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]')
  WHERE group_key = (SELECT group_key FROM bills WHERE id = OLD.bill_id);
END;

UPDATE bills SET group_tags = COALESCE((SELECT g.tags FROM bills g WHERE g.group_key = bills.group_key
      AND (g.ai_processed_at IS NOT NULL OR g.tenant_summary IS NOT NULL OR g.tags <> '[]')
      ORDER BY g.id = (SELECT l.id FROM bills l WHERE l.group_key = g.group_key
        ORDER BY l.status_rank DESC,
          (SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = l.id) DESC NULLS LAST,
          substr(l.bill_number, 1, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END) - 1) ASC,
          CAST(substr(l.bill_number, min(CASE WHEN instr(l.bill_number, '0') = 0 THEN 99999 ELSE instr(l.bill_number, '0') END, CASE WHEN instr(l.bill_number, '1') = 0 THEN 99999 ELSE instr(l.bill_number, '1') END, CASE WHEN instr(l.bill_number, '2') = 0 THEN 99999 ELSE instr(l.bill_number, '2') END, CASE WHEN instr(l.bill_number, '3') = 0 THEN 99999 ELSE instr(l.bill_number, '3') END, CASE WHEN instr(l.bill_number, '4') = 0 THEN 99999 ELSE instr(l.bill_number, '4') END, CASE WHEN instr(l.bill_number, '5') = 0 THEN 99999 ELSE instr(l.bill_number, '5') END, CASE WHEN instr(l.bill_number, '6') = 0 THEN 99999 ELSE instr(l.bill_number, '6') END, CASE WHEN instr(l.bill_number, '7') = 0 THEN 99999 ELSE instr(l.bill_number, '7') END, CASE WHEN instr(l.bill_number, '8') = 0 THEN 99999 ELSE instr(l.bill_number, '8') END, CASE WHEN instr(l.bill_number, '9') = 0 THEN 99999 ELSE instr(l.bill_number, '9') END)) AS INTEGER) ASC,
          l.id ASC LIMIT 1) DESC,
        g.match_type IS NOT NULL DESC, COALESCE(g.ai_processed_at, '') DESC, g.id DESC LIMIT 1), '[]')
WHERE group_key IS NOT NULL;
