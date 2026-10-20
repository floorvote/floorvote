-- The reverse side of a bill's relations: the sync pass asks which bills name a listed bill as their
-- companion (cron/sync.ts). Only the bill_id side was indexed, so that lookup scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_bill_sasts_sast_bill_id ON bill_sasts(sast_bill_id);
