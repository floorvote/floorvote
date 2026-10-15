-- A member's line under their name (their job title) is called "title" everywhere
-- now. It was `subtitle` in the Profile form, the database, and the API, while a
-- superadmin's copy in central was already `title` (#539).
--
-- The rename is two steps. This migration adds `title` and copies every value
-- across, but KEEPS `subtitle`, so the previous build, which reads and writes
-- `subtitle`, still works during the deploy and if the deploy is rolled back.
-- The code writes both columns until a later migration drops `subtitle`.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE users ADD COLUMN title TEXT;
UPDATE users SET title = subtitle;
