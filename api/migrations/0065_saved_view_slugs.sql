-- Human-readable identifiers for saved views, so a bookmark reads
-- /bills?view=clerk-bills instead of /bills?view=<uuid>.
-- Nullable because rows created before this column existed have none yet --
-- savedViewsApi's GET / backfills them the first time the list is read, the
-- same way customFieldsApi backfills custom field slugs.
ALTER TABLE saved_views ADD COLUMN slug TEXT;

-- One generation of back-compat for a rename: when a rename regenerates the
-- slug, the slug it replaces is kept here so a bookmark taken under the old
-- name keeps resolving. Not a full history -- a second rename shifts this
-- again and the slug from two renames back stops resolving. See the comment
-- on the PUT /admin/views/:id handler for the reasoning.
ALTER TABLE saved_views ADD COLUMN previous_slug TEXT;

-- SQLite unique indexes treat NULL as distinct from every other value, so
-- this allows any number of not-yet-backfilled rows with a NULL slug while
-- still enforcing uniqueness on every assigned slug.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_views_slug ON saved_views(slug);
