-- 0004_match_tracking.sql
-- Adds explicit match tracking to bill_tenants, denormalized last-action metadata
-- onto bills, and per-session sync config columns on sessions.

ALTER TABLE bill_tenants ADD COLUMN match_type TEXT;
-- match_type: 'keyword' | 'manual' | NULL (NULL = covered state but not tracked)

CREATE INDEX idx_bill_tenants_match_type ON bill_tenants(tenant_id, match_type);

ALTER TABLE bills ADD COLUMN last_action TEXT;
ALTER TABLE bills ADD COLUMN last_action_date TEXT;

ALTER TABLE sessions ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN full_sync_hours_et TEXT;  -- JSON array, NULL = use code default
ALTER TABLE sessions ADD COLUMN raw_sync_hours_et TEXT;   -- JSON array, NULL = use code default
