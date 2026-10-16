-- Index for the per-admin send limit on the admin email routes. The limit counts
-- the sign-in links and invites one admin sent in the past hour, and only rows
-- an admin caused have an actor_id, so a partial index stays tiny and keeps
-- that count off a scan of the whole table. The per-member count already rides
-- on idx_auth_events_user_created.
CREATE INDEX idx_auth_events_actor_created ON auth_events(actor_id, created_at) WHERE actor_id IS NOT NULL;
