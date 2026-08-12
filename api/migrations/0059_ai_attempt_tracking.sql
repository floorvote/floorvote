-- Record AI attempts that fail, not just ones that are permanently skipped.
--
-- ai_processed_at is set only on success and ai_skip_reason only for permanent,
-- per-document skips ('pdf_too_large', 'unreadable_document'). A transient
-- failure — provider outage, an exhausted AI Gateway credit balance, a bad
-- token — therefore leaves both NULL, making a bill that failed indistinguishable
-- from one that was never queued. Diagnosing it means reading Worker logs.
--
-- This is the same ambiguity central already fixed for bill text, where
-- bill_texts.fetch_attempted_at + fetch_error exist precisely so an undownloaded
-- document cannot masquerade as one that was never tried. Mirrors that pattern.
ALTER TABLE bills ADD COLUMN ai_attempted_at TEXT;
ALTER TABLE bills ADD COLUMN ai_error TEXT;
