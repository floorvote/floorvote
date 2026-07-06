-- Dynamic per-tenant queue delivery: store each tenant's Cloudflare Queues id so
-- central can HTTP-publish bills without a hand-added TENANT_QUEUE_<ID> producer
-- binding + redeploy. NULL = use the static binding only (legacy path).
ALTER TABLE tenants ADD COLUMN queue_id TEXT;

-- Backfill the three existing tenants (queue ids resolved from the Cloudflare
-- Queues REST API). These keep their static bindings, with queue_id as a fallback.
-- Backfill queue ids for your tenants (example values — replace with real ids):
-- UPDATE tenants SET queue_id = '<queue-id>' WHERE tenant_id = '<tenant-id>';
