-- Restore unique constraints lost when migration 0025 dropped and recreated tables.

-- comment_reactions: unique per (comment, user, emoji) — required for onConflictDoNothing idempotency
CREATE UNIQUE INDEX IF NOT EXISTS comment_reactions_comment_user_emoji_unique
  ON comment_reactions (comment_id, user_id, emoji);

-- notes: unique per (bill, user) — required for onConflictDoUpdate upsert in PUT /bills/:id/note
CREATE UNIQUE INDEX IF NOT EXISTS notes_bill_user_unique
  ON notes (bill_id, user_id);
