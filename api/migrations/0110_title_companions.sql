-- Companion suggestions from matching titles (#521). In states whose provider
-- names no identical companions, an admin's bill page suggests another bill
-- with the same title, one in the other chamber of the same session, and the
-- admin groups the two as "Group with..." does, or dismisses the suggestion.
--
-- bills.title_key is the key central serves for the bill (GET /bills/:id,
-- titleKey): its bill type and its title with case, punctuation, and
-- whitespace normalized, or null when no suggestion can come from the bill (a
-- state not opted in, a resolution, a stub whose chamber central has not read,
-- a title under 30 characters). bills.chamber is the bill's chamber as central
-- sends it (body). Both are written on every delivery of the bill
-- (api/src/lib/companionSuggestion.ts), never computed in a query.
--
-- Nothing here backfills them. Neither can be computed from what an instance
-- stores, since the bill type and chamber come only from central, so a bill
-- gets them on its next delivery, and POST /admin/refresh-metadata gives every
-- bill them at once, a statement per bill on the instance, the same work as
-- any metadata refresh. Until then a bill simply has no suggestion.
--
-- The lookup reads the bills of one state and session that hold one key,
-- through idx_bills_title_key, and never a whole state. A whole-state title
-- self-join once exceeded D1's CPU limit and reset a production database.
-- api/test/routes/companionSuggestionPlan.test.ts pins the plan. The index
-- holds only bills with a key, so ingest pays nothing for the rest, and a
-- query's title_key = ? implies the index's condition.
--
-- A dismissal is kept per pair of bills, smaller id first, as group overrides
-- are, in its own table rather than as a third kind of bill_group_overrides.
-- That table's CHECK allows only link and split, so a new kind would mean
-- rebuilding it, and every recompute of companion groups reads it, starting
-- with whether the instance has any row, so a dismissal stored there would
-- cost every delivery on an instance with no override a read per walked bill.
-- A dismissal goes when either bill is deleted.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE bills ADD COLUMN title_key TEXT;
ALTER TABLE bills ADD COLUMN chamber TEXT;
CREATE INDEX IF NOT EXISTS idx_bills_title_key ON bills (state, session_id, title_key) WHERE title_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS companion_suggestion_dismissals (
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  other_bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bill_id, other_bill_id),
  CHECK (bill_id < other_bill_id)
);
CREATE INDEX IF NOT EXISTS idx_companion_suggestion_dismissals_other ON companion_suggestion_dismissals (other_bill_id);
