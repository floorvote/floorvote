-- When the bill last had a full ingest: a full message from central applied,
-- as opposed to a stub (title, status, and latest action only). The bill page
-- decides full or stub from this, not from match_type, since an instance
-- receives full messages for bills it does not track.
-- The backfill marks the bills that show a full delivery: those with a match
-- type, an analysis, or a stored text key, which only the full path writes.
-- An untracked bill delivered in full before this column existed, with no text
-- key (central had no text for it), stays unmarked until its next full delivery.
ALTER TABLE bills ADD COLUMN fully_ingested_at TEXT;

UPDATE bills SET fully_ingested_at = updated_at
WHERE match_type IS NOT NULL OR ai_processed_at IS NOT NULL OR text_r2_key IS NOT NULL;
