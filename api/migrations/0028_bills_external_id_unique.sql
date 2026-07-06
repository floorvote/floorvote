-- Restore unique index on external_id that was lost when migration 0025 dropped and recreated the bills table.
-- Without this, concurrent queue messages for the same bill can both INSERT, creating duplicate rows.
-- SQLite treats NULL as distinct for uniqueness, so multiple manual bills (external_id = NULL) coexist fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_external_id ON bills(external_id);
