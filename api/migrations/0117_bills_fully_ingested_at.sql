-- When the bill last had a full ingest: a full message from central applied,
-- as opposed to a stub (title, status, and latest action only). The bill page
-- decides full or stub from this, not from match_type, since an instance
-- receives full messages for bills it does not track.
-- The backfill marks the bills that show a full delivery: those with a match
-- type or an analysis. It does not use text_r2_key, which a metadata-only
-- delivery writes too. An untracked bill delivered in full before this column
-- existed stays unmarked until its next full delivery. The UPDATE skips bills
-- already marked, so running it again changes nothing.
ALTER TABLE bills ADD COLUMN fully_ingested_at TEXT;

UPDATE bills SET fully_ingested_at = updated_at
WHERE fully_ingested_at IS NULL AND (match_type IS NOT NULL OR ai_processed_at IS NOT NULL);
