-- Whether the tenant has replaced the generic default AI instructions.
--
-- Reported by the tenant at registration. Surfaces on the operator's tenant
-- detail page: presets are retired and personalizing is a nagged default rather
-- than an enforced precondition, so the operator needs to see which instances are
-- still summarizing generically. Defaults to 0 so tenants that have not
-- re-registered since this shipped read as not-personalized.
ALTER TABLE tenants ADD COLUMN ai_context_personalized INTEGER NOT NULL DEFAULT 0;
