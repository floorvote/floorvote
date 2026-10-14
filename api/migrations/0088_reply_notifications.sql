-- Reply notifications (#354, part of #351). A new comment notifies the bill's
-- other commenters with a notification of kind 'reply', and emails them unless
-- they turned that off.
--
--   users.email_replies_enabled   per-member switch for reply emails. On by
--                                 default. Reply notifications in the app are
--                                 written whatever it says.
--
-- A reply is unique per comment and recipient, like a mention, so a retried
-- fan-out can't notify anyone twice. kind has no CHECK (0085), so no rebuild.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE users ADD COLUMN email_replies_enabled INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX idx_notifications_reply_unique ON notifications(comment_id, recipient_id) WHERE kind = 'reply';
