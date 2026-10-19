-- A member's inclusion of a saved view in their email digest (#449).
--
-- One row per member and view. The row rides on both: deleting a view or a
-- member removes it. No existing table or row is touched. The view's filter is
-- never copied here, so an edit to the view carries through to its subscribers.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
CREATE TABLE IF NOT EXISTS saved_view_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, view_id)
);

-- The digest reads a view's subscribers, and a delete reaches rows by view.
CREATE INDEX IF NOT EXISTS idx_saved_view_subscriptions_view ON saved_view_subscriptions(view_id);
