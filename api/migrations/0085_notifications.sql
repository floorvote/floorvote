-- The notifications inbox (#352, part of #351). One stored row per event a
-- member is notified about, of several kinds, with mentions as the first.
--
--   recipient_id  who is notified
--   kind          what happened. Only 'mention' today. Replies and reactions
--                 arrive as new kinds, so there is no CHECK on it (SQLite would
--                 need a table rebuild to widen one).
--   bill_id       the bill it concerns. Moves with its comments when a draft is
--                 linked to a filed bill.
--   comment_id    the comment it concerns. Nullable for a future kind about a
--                 bill alone (a hearing on a followed bill, say).
--   actor_id      who caused it (a mention's comment author)
--   data          kind-specific JSON. A mention stores how it reached the
--                 recipient, as sourceType (user, role, or everyone) and
--                 sourceId (the user, the role, or all).
--   read_at       null until the recipient has seen it
--
-- Notifications for deleted comments are hidden at read time, not deleted.
--
-- Existing comment_mentions rows carry over with their ids, timestamps, and
-- read state, then the table is dropped. Keeping the ids is what lets a demo
-- browser's local read state (keyed on them) survive the upgrade. A person
-- reached twice by one comment (a past concurrent-edit race) keeps only the
-- earliest record, since a mention is now unique per comment and recipient.
-- Mentions on a comment whose bill or author no longer exists are not carried
-- over. comments has had no foreign keys since 0025, so such comments can
-- exist, and the old panel never showed their mentions (it inner-joined both).
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);

CREATE INDEX idx_notifications_recipient_created ON notifications(recipient_id, created_at);
CREATE INDEX idx_notifications_comment ON notifications(comment_id);
CREATE INDEX idx_notifications_bill_recipient ON notifications(bill_id, recipient_id);
CREATE UNIQUE INDEX idx_notifications_mention_unique ON notifications(comment_id, recipient_id) WHERE kind = 'mention';

INSERT OR IGNORE INTO notifications (id, recipient_id, kind, bill_id, comment_id, actor_id, data, created_at, read_at)
  SELECT cm.id, cm.user_id, 'mention', c.bill_id, cm.comment_id, c.user_id,
         json_object('sourceType', cm.source_type, 'sourceId', cm.source_id),
         cm.created_at, cm.read_at
  FROM comment_mentions cm
  JOIN comments c ON c.id = cm.comment_id
  JOIN bills b ON b.id = c.bill_id
  JOIN users a ON a.id = c.user_id
  JOIN users r ON r.id = cm.user_id
  ORDER BY cm.created_at, cm.id;

DROP TABLE comment_mentions;
