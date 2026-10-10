-- What each bill calendar entry is: hearing, markup, meeting, or deadline
-- (#295). Central now sends a kind with every entry it sends, so the instance
-- keeps it rather than working it out from the entry's identity or type.
--
-- A nullable column. A bill's entries get their kind the next time central
-- sends the bill's calendar. Custom events have none.
--
-- The UPDATE is for a fork that ran the DC deadline code from PR 217, which
-- filed bill deadlines under their own source. Upstream shows and cancels bill
-- calendar entries only under source hearing, so those rows move there with
-- their kind. On every other instance it changes no rows.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE calendar_events ADD COLUMN kind TEXT;
UPDATE calendar_events SET source = 'hearing', kind = 'deadline' WHERE source = 'deadline';
