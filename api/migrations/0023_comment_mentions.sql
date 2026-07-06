CREATE TABLE comment_mentions (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comment_mentions_user ON comment_mentions(user_id);
CREATE INDEX idx_comment_mentions_comment ON comment_mentions(comment_id);
