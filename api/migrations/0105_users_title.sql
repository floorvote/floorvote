-- A member's line under their name (their job title) is called "title" everywhere
-- now. It was `subtitle` in the Profile form, the database, and the API, while a
-- superadmin's copy in central was already `title` (#539). A rename keeps every
-- value and rewrites no rows.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE users RENAME COLUMN subtitle TO title;
