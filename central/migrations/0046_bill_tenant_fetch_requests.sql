-- 0046_bill_tenant_fetch_requests.sql
-- When this instance last asked central for the bill through POST /tenants/fetch-bills,
-- as it does for a companion it analyzes through its group without tracking it.
-- While the request is recent (lib/fetchRequests.ts), the sync ingests the bill whenever
-- its change hash moves, so the instance gets its new texts, within the budget that
-- untracked bills' fetches share (lib/stubRefresh.ts). NULL means never asked.
ALTER TABLE bill_tenants ADD COLUMN fetch_requested_at TEXT;
