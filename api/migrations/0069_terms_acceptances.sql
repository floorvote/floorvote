-- One row per acceptance of the Legal Terms, never updated.
--
-- Append-only rather than a nullable terms_accepted_at column on users, which
-- is what docs/backlog.md originally proposed. A single timestamp is lossy --
-- re-acceptance overwrites it, so after the first material change there is no
-- way to show which text a user accepted previously, and that earlier version
-- is the one any dispute about past conduct turns on. A row per acceptance
-- costs one small table and makes re-acceptance an insert.
--
-- terms_updated records the LEGAL_TERMS_UPDATED value the user accepted
-- against, so a row plus the git history of docs/legal/ is a complete record
-- of the exact text accepted. It is a YYYY-MM-DD string compared
-- lexicographically, never through datetime().
--
-- ON DELETE CASCADE matches sessions. Deactivation is a soft 403 in
-- requireAuth, so live accounts and their records persist. Only genuine
-- account deletion removes these rows.
--
-- ============================================================================
-- DEPLOY ORDER: apply this migration BEFORE deploying the api worker.
-- requireAuth reads terms_acceptances on every authenticated request, so a
-- worker that ships first fails closed on all of them with "no such table".
-- npm run deploy:tenant applies pending migrations first, so the normal path
-- is safe. This warning is for a hand-rolled wrangler deploy.
--
-- (Keep semicolons out of these comments. api/test/helpers.ts splits migration
-- files on the statement terminator BEFORE it strips comment lines, so one
-- inside a comment turns the rest of that sentence into a statement and every
-- test that applies migrations fails with a syntax error.)
-- ============================================================================
CREATE TABLE terms_acceptances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_updated TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_terms_acceptances_user ON terms_acceptances(user_id, accepted_at);
