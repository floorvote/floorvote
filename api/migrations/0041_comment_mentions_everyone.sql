-- Allow 'everyone' as a comment_mentions source_type.
-- SQLite cannot ALTER a CHECK constraint, so rebuild the table.
CREATE TABLE comment_mentions_new (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('user', 'role', 'everyone')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);

INSERT INTO comment_mentions_new (id, comment_id, user_id, source_type, source_id, created_at, read_at)
SELECT id, comment_id, user_id, source_type, source_id, created_at, read_at FROM comment_mentions;

DROP TABLE comment_mentions;

ALTER TABLE comment_mentions_new RENAME TO comment_mentions;

CREATE INDEX idx_comment_mentions_user ON comment_mentions(user_id);
CREATE INDEX idx_comment_mentions_comment ON comment_mentions(comment_id);
