-- Members' digests carry the new-match section (#366, part of #363).
--
--   users.email_digest_matches_enabled   the member's "Include newly matched
--                                        bills" option, nested under their digest
--                                        switch. On by default. Admins always get
--                                        the section, so it is ignored for them.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE users ADD COLUMN email_digest_matches_enabled INTEGER NOT NULL DEFAULT 1;
