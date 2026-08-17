-- Drop the dead instance_preset bookkeeping key.
--
-- The presets feature is retired. instance_preset only ever recorded which preset
-- had been applied. The four functional values it wrote (ai_context,
-- relevance_question, tag_taxonomy, keywords) are independent rows and are
-- deliberately untouched here, so existing tenants keep the configuration they run
-- on today.
DELETE FROM association_config WHERE key = 'instance_preset';
