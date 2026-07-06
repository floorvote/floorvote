-- Remove dead association_config keys.
--   allowed_domains  — seeded by 0001_initial, never read by any code.
--   reaction_emojis  — orphaned when the comment-reaction picker was hardcoded
--                      (ReactionPicker uses a fixed emoji list; the config value
--                      no longer affects anything).
-- Neither key has a writer, so deleting them is permanent.
DELETE FROM association_config WHERE key IN ('allowed_domains', 'reaction_emojis');
