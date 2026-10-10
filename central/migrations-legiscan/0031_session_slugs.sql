-- Each session's URL slug, the SESSION in a bill's /STATE/SESSION/BILL URL,
-- stored and unique within its state. Tenants computed it from the session
-- name, so two sessions of one state could share a slug (two providers'
-- "2026 Regular Session", say) and a bill URL could resolve to the wrong bill.
--
-- The column starts empty on every existing row, which a unique index allows,
-- so this migration can't fail on existing data. Core fills it in TypeScript
-- (src/lib/sessionSlugs.ts), with the same sessionToSlug tenants use today, on
-- the first cron tick after the deploy and whenever it writes a session. A
-- slug another session of the state already holds gets -2, -3, and so on, the
-- session with the lowest id keeping the plain slug. SQLite has no regular
-- expressions, so a copy of the slug rules here would drift from the one
-- tenants use, and change existing bill URLs where it did.
ALTER TABLE sessions ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_sessions_state_slug ON sessions(state, slug);
