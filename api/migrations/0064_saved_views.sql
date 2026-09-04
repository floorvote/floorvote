-- Named filter sets over the bill list. A view is a name plus the serialized
-- query string the bill list already round-trips through its URL, so no per-bill
-- storage exists and no backfill is needed.
-- All views are shared tenant-wide. Reads are member-accessible, writes admin-only.
CREATE TABLE IF NOT EXISTS saved_views (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  query         TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The only read pattern is "every view, in creation order".
CREATE INDEX IF NOT EXISTS idx_saved_views_order ON saved_views(display_order);
