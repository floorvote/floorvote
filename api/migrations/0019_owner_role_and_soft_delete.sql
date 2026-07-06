-- Add soft-delete columns to comments
ALTER TABLE comments ADD COLUMN deleted_at TEXT;
ALTER TABLE comments ADD COLUMN deleted_by TEXT;

-- Add soft-delete column to comment_reactions
ALTER TABLE comment_reactions ADD COLUMN deleted_at TEXT;
