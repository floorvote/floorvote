-- Per-bill mute (#355, part of #351). A member who mutes a bill's comments gets
-- no reply notifications for it, in the app or by email. Mentions still reach
-- them. A member can mute a bill whether or not they have commented on it.
--
-- One row per muted bill and member. Muting is a row and unmuting deletes it.
-- Both foreign keys cascade, so deleting a member or a bill clears its mutes.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE bill_mutes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, bill_id)
);

CREATE INDEX idx_bill_mutes_bill ON bill_mutes(bill_id);
