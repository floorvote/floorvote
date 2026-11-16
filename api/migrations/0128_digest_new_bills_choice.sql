-- A person's "Newly found bills" choice can be unset, so a member follows the team's default (#1036). The default is
-- the email-digest module's newBillsDefault, which is on unless it is set to false. An admin or owner whose choice is
-- unset gets the part, since they decide which new bills the team follows.
--
-- users.email_digest_matches_enabled is NOT NULL, and SQLite can't drop that in place. Rebuilding users would drop
-- the table, and D1 keeps foreign keys on, so the drop would run the ON DELETE CASCADE and SET NULL actions that
-- point at users. That would empty sessions, among other tables. The choice moves to a new nullable column instead.
-- 1 is on, 0 is off, and NULL is unset. A person added from here on starts unset.
--
-- The old column keeps its values. The build that ships with this migration stops reading and writing it. A deploy
-- applies migrations before it swaps the Worker, so the previous build, which reads the old column, runs as before
-- until the new one is live.
ALTER TABLE users ADD COLUMN email_digest_new_bills INTEGER;

-- Every off stays off, and every other value stays unset. The default starts on, so nobody's email changes.
-- Some of these offs are not the person's own choice. Migration 0127 turned off the switch of everyone whose digest
-- switch was off. Keeping those offs keeps those people without newly found bills, which is what they got before.
UPDATE users SET email_digest_new_bills = 0 WHERE email_digest_matches_enabled = 0;
