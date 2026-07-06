-- Patch seed data: fix relevance scores (0-10), vary tags, add test admin activity, upcoming hearing
-- Run: cd api && npx wrangler d1 execute floorvote-dev --local --env dev --file=../scripts/seed-dev-patch.sql

-- === FIX RELEVANCE SCORES (0-10 scale) ===
UPDATE bills SET relevance_score = 9 WHERE id = 'bill-voter-id';
UPDATE bills SET relevance_score = 10 WHERE id = 'bill-early-vote';
UPDATE bills SET relevance_score = 8 WHERE id = 'bill-cyber';
UPDATE bills SET relevance_score = 5 WHERE id = 'bill-rcv';
UPDATE bills SET relevance_score = 10 WHERE id = 'bill-training';
UPDATE bills SET relevance_score = 9 WHERE id = 'bill-mail';
UPDATE bills SET relevance_score = 7 WHERE id = 'bill-access';
UPDATE bills SET relevance_score = 6 WHERE id = 'bill-edr';
UPDATE bills SET relevance_score = 4 WHERE id = 'bill-redistrict';
UPDATE bills SET relevance_score = 5 WHERE id = 'bill-campaign';
UPDATE bills SET relevance_score = 8 WHERE id = 'bill-pollworker';
UPDATE bills SET relevance_score = 7 WHERE id = 'bill-rolls';

-- === VARY TAGS (1-5 per bill) ===
UPDATE bills SET tags = '["Voter ID"]' WHERE id = 'bill-voter-id';
UPDATE bills SET tags = '["Early Voting","Voter Access","Election Administration","Municipal Operations","Staffing"]' WHERE id = 'bill-early-vote';
UPDATE bills SET tags = '["Election Security","Cybersecurity","Election Administration","Infrastructure"]' WHERE id = 'bill-cyber';
UPDATE bills SET tags = '["Ranked Choice Voting","Election Reform"]' WHERE id = 'bill-rcv';
UPDATE bills SET tags = '["Election Officials & Administration","Training","Certification","Professional Development","Workforce"]' WHERE id = 'bill-training';
UPDATE bills SET tags = '["Mail Voting","Ballot Processing"]' WHERE id = 'bill-mail';
UPDATE bills SET tags = '["Voter Access","ADA Compliance","Election Administration","Accessibility"]' WHERE id = 'bill-access';
UPDATE bills SET tags = '["Voter Registration"]' WHERE id = 'bill-edr';
UPDATE bills SET tags = '["Redistricting","Election Reform","Constitutional Amendment"]' WHERE id = 'bill-redistrict';
UPDATE bills SET tags = '["Campaign Finance","Transparency"]' WHERE id = 'bill-campaign';
UPDATE bills SET tags = '["Election Officials & Administration","Poll Workers","Compensation","Recruitment","Bilingual Services"]' WHERE id = 'bill-pollworker';
UPDATE bills SET tags = '["Voter Registration","Data Management"]' WHERE id = 'bill-rolls';

-- === TEST ADMIN VOTES ===
INSERT OR IGNORE INTO member_votes (id, user_id, bill_id, position, created_at) VALUES
  ('mv-ta-1', 'test-user-1', 'bill-voter-id', 'oppose', '2026-01-14 10:00:00'),
  ('mv-ta-2', 'test-user-1', 'bill-early-vote', 'support', '2026-01-22 09:00:00'),
  ('mv-ta-3', 'test-user-1', 'bill-training', 'support', '2025-12-03 14:00:00'),
  ('mv-ta-4', 'test-user-1', 'bill-cyber', 'support', '2026-02-08 11:00:00'),
  ('mv-ta-5', 'test-user-1', 'bill-pollworker', 'support', '2025-12-06 09:00:00'),
  ('mv-ta-6', 'test-user-1', 'bill-mail', 'neutral', '2026-01-28 15:00:00');

-- === TEST ADMIN COMMENTS ===
INSERT OR IGNORE INTO comments (id, bill_id, user_id, content, created_at) VALUES
  ('c-ta-1', 'bill-voter-id', 'test-user-1', '<p>I ran the numbers for our county — we''d need to process about 200 free IDs per week in the lead-up to November. That''s <strong>not feasible</strong> with current staffing.</p>', '2026-01-17 10:00:00'),
  ('c-ta-2', 'bill-early-vote', 'test-user-1', '<p>We have two potential sites in Cranston that could work as early voting centers. I''ll bring the details to the next meeting. <span data-type="mention" data-id="user:user-sarah" data-label="Sarah Wright">@Sarah Wright</span> want to coordinate on this?</p>', '2026-03-16 14:00:00'),
  ('c-ta-3', 'bill-cyber', 'test-user-1', '<p>Our current systems are already using MFA but the <em>penetration testing</em> requirement is new. The CISA offer for free testing is worth pursuing — <span data-type="mention" data-id="role:role-tech" data-label="Technology & Modernization">@Technology & Modernization</span> thoughts?</p>', '2026-03-04 09:00:00'),
  ('c-ta-4', 'bill-training', 'test-user-1', '<p>Congratulations everyone. This is exactly the kind of professionalization our field needs. Happy to help develop the curriculum.</p>', '2026-04-16 10:00:00'),
  ('c-ta-5', 'bill-pollworker', 'test-user-1', '<p>The $200 minimum will make a real difference in recruitment. Last cycle we had 4 no-shows on election day — better pay means more reliable workers.</p>', '2025-12-12 11:00:00');

-- === TEST ADMIN PERSONAL NOTES ===
INSERT OR IGNORE INTO notes (id, bill_id, user_id, content, created_at) VALUES
  ('n-ta-1', 'bill-voter-id', 'test-user-1', 'Follow up with county legal on provisional ballot statistics from 2024. How many provisionals were cast and how many were ultimately counted?', '2026-01-16 09:00:00'),
  ('n-ta-2', 'bill-early-vote', 'test-user-1', 'Check with facilities dept re: Cranston Community Center availability. Need ADA assessment for the annex building too.', '2026-03-15 10:00:00'),
  ('n-ta-3', 'bill-cyber', 'test-user-1', 'Get quote from current IT vendor for annual pen testing. Compare with CISA free offer. Budget impact for FY27.', '2026-03-03 08:00:00'),
  ('n-ta-4', 'bill-pollworker', 'test-user-1', 'Track recruitment numbers after pay increase goes into effect. Baseline: 42 poll workers, 4 vacancies, 6 no-shows last cycle.', '2025-12-20 14:00:00');

-- === UPCOMING HEARING ===
INSERT OR IGNORE INTO bill_calendar (id, bill_id, event_hash, type_id, type, date, time, location, description) VALUES
  ('cal-upcoming-1', 'bill-early-vote', 'eh-upcoming-1', 1, 'House State Government', '2026-06-15', '10:00 AM', 'Room 205, State House', 'Committee hearing on SB 2218 — association testimony scheduled'),
  ('cal-upcoming-2', 'bill-cyber', 'eh-upcoming-2', 1, 'House Innovation', '2026-06-10', '2:00 PM', 'Room 101, State House', 'Second hearing; amendment discussion'),
  ('cal-upcoming-3', 'bill-mail', 'eh-upcoming-3', 2, 'Senate Judiciary', '2026-05-28', '9:30 AM', 'Lounge A, State House', 'Committee vote expected');

-- === FEED EVENTS FOR TEST ADMIN ===
INSERT OR IGNORE INTO feed_events (id, type, bill_id, user_id, metadata, created_at) VALUES
  ('fe-ta-1', 'comment_added', 'bill-voter-id', 'test-user-1', '{"preview":"I ran the numbers for our county — we''d need to process about 200 free IDs per week.","billNumber":"HB 5042","billTitle":"Voter Identification Requirements"}', '2026-01-17 10:00:00'),
  ('fe-ta-2', 'comment_added', 'bill-early-vote', 'test-user-1', '{"preview":"We have two potential sites in Cranston that could work as early voting centers.","billNumber":"SB 2218","billTitle":"Early Voting Centers"}', '2026-03-16 14:00:00'),
  ('fe-ta-3', 'comment_added', 'bill-training', 'test-user-1', '{"preview":"Congratulations everyone. This is exactly the kind of professionalization our field needs.","billNumber":"SB 2500","billTitle":"Election Official Training"}', '2026-04-16 10:00:00');
