-- 0029_bills_is_stub.sql
-- Adds is_stub flag distinguishing metadata-only bills (no AI, no text)
-- from fully-tracked bills.
ALTER TABLE bills ADD COLUMN is_stub INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_bills_is_stub ON bills(is_stub) WHERE is_stub = 1;
