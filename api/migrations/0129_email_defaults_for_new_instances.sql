-- A new instance starts with the team's emails on (DEFAULT_MODULES in shared/modules.ts): the email digest with priority
-- bills and saved views, every day, and the week ahead email on Fridays. From this build on, an instance that never
-- saved its modules reads as those defaults.
--
-- An instance that already has people keeps what it gets today. One that never saved its modules sends neither email
-- today, so it saves an empty set, which reads as both off. A new database has no people when its migrations run, so
-- it saves nothing and starts with the defaults.
INSERT INTO association_config (key, value)
SELECT 'modules', '{}'
WHERE EXISTS (SELECT 1 FROM users)
  AND NOT EXISTS (SELECT 1 FROM association_config WHERE key = 'modules');
