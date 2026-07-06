-- summary and ai_processed_at were planned for a central genericSummary pass
-- that was never implemented. All AI processing happens at the tenant level.
ALTER TABLE bills DROP COLUMN summary;
ALTER TABLE bills DROP COLUMN ai_processed_at;
