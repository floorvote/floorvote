ALTER TABLE bills ADD COLUMN match_type TEXT CHECK(match_type IN ('keyword', 'manual'));

-- Backfill: bills that have had AI run are keyword matches
UPDATE bills SET match_type = 'keyword' WHERE ai_processed_at IS NOT NULL;
-- All other bills (stubs, non-matching) stay NULL

-- Drop the now-redundant source column (all logic replaced by match_type)
ALTER TABLE bills DROP COLUMN source;
