-- Example-screenshot overlay: transforms the standard dev seed into a
-- fictitious state suitable for product screenshots.
--
-- Run AFTER seed-dev.sql on a fresh local DB:
--   cd api && npx wrangler d1 execute floorvote-dev --local --file=../scripts/example-screenshots/seed.sql
--
-- All names, titles, and bill content are fictional.

-- ── Users: rename the two visible in the bill-detail screenshot ─────────────

UPDATE users SET name = 'Chad Mitchell',  subtitle = 'Registrar, Amity Island'
  WHERE id = 'user-maria';

UPDATE users SET name = 'Gerry Webb',     subtitle = 'Clerk, Emerald City'
  WHERE id = 'user-david';

-- ── Roles: rename the one mentioned in comments ────────────────────────────

UPDATE roles SET name = 'Deputy Clerks' WHERE id = 'role-outreach';

-- ── Bill: rewrite bill-early-vote with fictitious content ──────────────────

UPDATE bills SET
  bill_number     = 'HB 1247',
  title           = 'The Election Access and Verification Act',
  status          = '1',
  abstract        = NULL,
  tenant_summary  = 'Makes changes to state law that would enable early in-person voting, improve post-election auditing, and create a funding source for county election offices.

- **Early voting:** Requires each county to designate at least one permanent early voting center per 40,000 residents, open for a minimum of seven days before federal elections, including evenings and weekends.
- **Pre-certification audits:** Adjusts the timeline of post-election audits so that they are completed before results are certified.
- **Funding:** Appropriates $8 million in state funding to support the above, as well as facility upgrades, staffing, and security equipment.',
  sponsor         = 'Rep. Rosa Tavares',
  sponsor_party   = 'D',
  sponsor_url     = 'https://legislature.example.gov/members/tavares',
  last_action     = 'Reported favorably with amendments; scheduled for floor vote',
  last_action_date = '2026-09-10',
  history         = '[{"date":"2026-06-10","action":"Introduced","chamber":"House"},{"date":"2026-06-18","action":"Referred to House Elections Committee","chamber":"House"},{"date":"2026-07-15","action":"Committee hearing held","chamber":"House"},{"date":"2026-08-22","action":"Fiscal impact study requested","chamber":"House"},{"date":"2026-09-03","action":"Fiscal impact report received","chamber":"House"},{"date":"2026-09-10","action":"Reported favorably with amendments","chamber":"House"}]',
  state_link      = 'https://legislature.example.gov/billtracker',
  committee       = 'House Elections Committee',
  co_sponsors     = '[{"name":"Rep. Dara Whitfield","party":"R","role":"Rep","district":"14","url":"https://legislature.example.gov/members/whitfield"}]',
  relevance_score = 9,
  updated_at      = '2026-09-11 14:00:00'
WHERE id = 'bill-early-vote';

-- ── Comments on bill-early-vote ────────────────────────────────────────────
-- Delete the original batch and insert two short ones.

DELETE FROM comments WHERE bill_id = 'bill-early-vote';

INSERT OR REPLACE INTO comments (id, bill_id, user_id, content, created_at) VALUES
  ('c-1', 'bill-early-vote', 'user-maria',
   '<p>We filed a support position. The bipartisan sponsor pair is encouraging; Tavares and Whitfield don''t often co-lead. The $8M appropriation is great, but we should flag the recurring funding gap in our <a href="https://legislature.example.gov/testimony" target="_blank">testimony</a>.</p>',
   '2026-09-12 10:00:00'),
  ('c-2', 'bill-early-vote', 'user-david',
   '<p><span data-type="mention" data-id="user:user-maria" data-label="Chad Mitchell">@Chad Mitchell</span>, I agree. The pre-certification audit piece is something the minority caucus pushed for. Wondering what the <span data-type="mention" data-id="role:role-outreach" data-label="Deputy Clerks">@Deputy Clerks</span> think about the early voting provisions.</p>',
   '2026-09-13 09:00:00');

-- ── Reactions on the new comments ──────────────────────────────────────────

DELETE FROM comment_reactions WHERE comment_id IN ('c-1','c-2','c-7','c-8','c-9','c-10','c-11','c-12');

INSERT OR REPLACE INTO comment_reactions (id, comment_id, user_id, emoji, created_at) VALUES
  ('cr-1', 'c-1', 'user-david', '👍', '2026-09-12 10:30:00'),
  ('cr-2', 'c-1', 'user-sarah', '👍', '2026-09-12 11:00:00'),
  ('cr-3', 'c-1', 'user-james', '💯', '2026-09-12 11:30:00'),
  ('cr-4', 'c-2', 'user-maria', '👍', '2026-09-13 09:30:00');

-- ── Personal note ──────────────────────────────────────────────────────────

UPDATE notes SET
  content = 'Follow up with Susan on the fiscal impact analysis before the committee markup. Check comparison data on early voting costs in similar-sized states.'
WHERE id = 'n-2' AND bill_id = 'bill-early-vote';

-- The demo-user note (visible when logged in as demo user):
DELETE FROM notes WHERE bill_id = 'bill-early-vote' AND user_id = 'demo-user';
INSERT OR REPLACE INTO notes (id, bill_id, user_id, content, created_at) VALUES
  ('n-ex-1', 'bill-early-vote', 'demo-user',
   'Follow up with Susan on the fiscal impact analysis before the committee markup. Check comparison data on early voting costs in similar-sized states.',
   '2026-09-13 09:00:00');

-- ── Bill text type: "Comm. Sub." instead of "Committee Amendment" ───────────

UPDATE bill_texts SET type = 'Comm. Sub.', date = '2026-09-10'
  WHERE bill_id = 'bill-early-vote' AND doc_id = 10003;

-- ── Member votes: replace with 12 votes (7 support / 3 neutral / 2 oppose) ─

DELETE FROM member_votes WHERE bill_id = 'bill-early-vote';
UPDATE users SET can_vote = 1 WHERE id = 'user-amy';

-- Need 12 distinct voters; the standard seed has 10 users + demo-user = 11.
-- Add one extra user so we reach 12.
INSERT OR IGNORE INTO users (id, email, name, role, can_vote, created_at)
  VALUES ('user-ex-voter', 'pat.hernandez@example.com', 'Pat Hernandez', 'member', 1, '2026-01-15 10:00:00');

INSERT INTO member_votes (id, user_id, bill_id, position, created_at) VALUES
  ('mv-8',    'user-maria',    'bill-early-vote', 'support', '2026-09-10 10:00:00'),
  ('mv-9',    'user-david',    'bill-early-vote', 'support', '2026-09-10 11:00:00'),
  ('mv-10',   'user-sarah',    'bill-early-vote', 'support', '2026-09-10 12:00:00'),
  ('mv-11',   'user-james',    'bill-early-vote', 'support', '2026-09-10 13:00:00'),
  ('mv-12',   'user-linda',    'bill-early-vote', 'support', '2026-09-10 14:00:00'),
  ('mv-14',   'user-tom',      'bill-early-vote', 'support', '2026-09-10 16:00:00'),
  ('mv-15',   'user-rachel',   'bill-early-vote', 'support', '2026-09-11 09:00:00'),
  ('mv-13',   'user-mike',     'bill-early-vote', 'neutral', '2026-09-10 15:00:00'),
  ('mv-ex-1', 'user-amy',      'bill-early-vote', 'neutral', '2026-09-11 10:00:00'),
  ('mv-ex-2', 'user-noname',   'bill-early-vote', 'neutral', '2026-09-11 11:00:00'),
  ('mv-ex-3', 'demo-user',     'bill-early-vote', 'oppose',  '2026-09-11 12:00:00'),
  ('mv-ex-4', 'user-ex-voter', 'bill-early-vote', 'oppose',  '2026-09-11 13:00:00');

-- ── Position (already "Support" from standard seed, but update the note) ────

UPDATE official_positions SET
  notes = 'Critical infrastructure for voter access; bipartisan support is encouraging'
WHERE bill_id = 'bill-early-vote';
