-- Per-tenant latency probe for the daily engagement pull. Records the
-- round-trip time (ms) and success of each tenant's pull call so a degrading
-- tenant can be caught early. Reuses tenant_stats' existing daily key
-- (tenant_id, stat_date) and pulled_at timestamp — no new probe_at needed.
ALTER TABLE tenant_stats ADD COLUMN probe_latency_ms INTEGER;
ALTER TABLE tenant_stats ADD COLUMN probe_ok INTEGER;
