-- When the bill last had a full ingest: a full message from central applied,
-- as opposed to a stub (title, status, and latest action only). The bill page
-- decides full or stub from this, not from match_type, since an instance
-- receives full messages for bills it does not track.
-- The backfill marks the bills that could only have arrived in full, those
-- with a match type or an analysis. An untracked bill delivered in full before
-- this column existed stays unmarked until its next full delivery.
ALTER TABLE bills ADD COLUMN fully_ingested_at TEXT;

UPDATE bills SET fully_ingested_at = updated_at
WHERE match_type IS NOT NULL OR ai_processed_at IS NOT NULL;
