-- Files attached to comments (#465).
--
-- One row per file. The bytes live in the ATTACHMENTS_BUCKET R2 bucket under
-- r2_key, which is the instance's TENANT_ID, a slash, and a random UUID, so one
-- bucket can serve several instances. A row starts with no comment while it
-- uploads. confirmed_at is set once the server has checked the stored bytes,
-- and comment_id once the comment is posted. Deleting the comment sets
-- deleted_at, and a cron purges the bytes and the row 30 days later. Uploads
-- never posted are purged after a day.
--
-- No existing table or row is touched. No semicolons in these comments, since
-- the test harness splits migration files on the statement terminator.
CREATE TABLE IF NOT EXISTS comment_attachments (
  id TEXT PRIMARY KEY,
  comment_id TEXT,
  uploader_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

-- A comment's files are read by comment, and the hourly limit counts an uploader's recent rows.
CREATE INDEX IF NOT EXISTS idx_comment_attachments_comment ON comment_attachments(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_attachments_uploader ON comment_attachments(uploader_id, created_at);
