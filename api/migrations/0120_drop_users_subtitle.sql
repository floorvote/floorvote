-- Finish the rename of a member's line under their name from `subtitle` to
-- `title` (#539, #564). Migration 0105 added `title` and kept `subtitle`, so the
-- previous build, which read and wrote `subtitle`, kept working through the
-- deploy and a rollback. That build is gone everywhere now, so `subtitle` goes.
--
-- First copy across any `subtitle` that has no `title`, which is a member the
-- previous build wrote after 0105 ran. A `title` already set wins, since this
-- build always wrote both columns and the two differ only when the previous
-- build edited a title, with no telling which is newer.
--
-- Nothing indexes, references, or triggers on `users.subtitle`, so the column
-- drops in place with no table rebuild.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
UPDATE users SET title = subtitle WHERE title IS NULL AND subtitle IS NOT NULL;
ALTER TABLE users DROP COLUMN subtitle;
