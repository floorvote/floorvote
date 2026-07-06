-- Draft (pre-filed) bills: admin-created, tenant-local, no central record, no AI until linked.
ALTER TABLE bills ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN draft_text TEXT;
CREATE INDEX idx_bills_is_draft ON bills(is_draft);
