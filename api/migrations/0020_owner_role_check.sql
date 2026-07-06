-- No-op: owner role CHECK constraint is now baked into 0001_initial.sql.
-- This migration previously attempted a table recreation, but D1's migration
-- runner doesn't reliably execute multi-statement PRAGMA + DDL files.
-- Existing tenants (staging, RI) were fixed manually via wrangler d1 execute --file.
SELECT 1;
