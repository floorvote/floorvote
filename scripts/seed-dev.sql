-- Seed script for local dev: realistic fake data
-- Run: cd api && npx wrangler d1 execute floorvote-dev --local --file=../scripts/seed-dev.sql

-- === USERS ===
INSERT OR IGNORE INTO users (id, email, name, role, subtitle, can_vote, created_at) VALUES
  ('user-maria', 'maria.chen@example.com', 'Maria Chen', 'owner', 'Executive Director', 1, '2025-09-15 10:00:00'),
  ('user-david', 'david.park@example.com', 'David Park', 'admin', 'Legislative Analyst', 1, '2025-10-02 09:00:00'),
  ('user-sarah', 'sarah.wright@example.com', 'Sarah Wright', 'member', 'County Clerk, Warwick', 1, '2025-10-10 14:00:00'),
  ('user-james', 'james.oconnor@example.com', 'James O''Connor', 'member', 'Town Clerk, Cranston', 1, '2025-10-12 08:30:00'),
  ('user-linda', 'linda.nguyen@example.com', 'Linda Nguyen', 'member', 'City Registrar, Providence', 1, '2025-10-20 11:00:00'),
  ('user-mike', 'mike.santos@example.com', 'Mike Santos', 'member', 'Board of Elections, Newport', 1, '2025-11-01 09:15:00'),
  ('user-rachel', 'rachel.kim@example.com', 'Rachel Kim', 'member', NULL, 1, '2025-11-15 16:00:00'),
  ('user-tom', 'tom.brennan@example.com', 'Tom Brennan', 'admin', 'Policy Director', 1, '2025-09-20 10:00:00'),
  ('user-amy', 'amy.foster@example.com', 'Amy Foster', 'member', 'Town Moderator, Bristol', 0, '2025-12-01 08:00:00'),
  ('user-noname', 'newuser@example.com', '', 'member', NULL, 1, '2026-01-05 10:00:00');

-- === ROLES ===
INSERT OR IGNORE INTO roles (id, name) VALUES
  ('role-leg', 'Legislative Committee'),
  ('role-tech', 'Technology & Modernization'),
  ('role-outreach', 'Voter Outreach'),
  ('role-exec', 'Executive Board');

-- === USER-ROLE ASSIGNMENTS ===
INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES
  ('user-maria', 'role-exec'),
  ('user-david', 'role-leg'),
  ('user-david', 'role-exec'),
  ('user-tom', 'role-leg'),
  ('user-tom', 'role-tech'),
  ('user-sarah', 'role-leg'),
  ('user-sarah', 'role-outreach'),
  ('user-james', 'role-tech'),
  ('user-linda', 'role-outreach'),
  ('user-linda', 'role-leg'),
  ('user-mike', 'role-tech'),
  ('user-mike', 'role-outreach');

-- === BILLS ===
-- Invariant: the queue processor (api/src/queue/processor.ts) writes tenant_summary,
-- tags, relevance_score, and ai_processed_at together in one statement, and
-- migration 0031_bill_match_type.sql backfills match_type = 'keyword' wherever
-- ai_processed_at is set. So a seeded row must either carry ALL of
-- match_type/ai_processed_at/tenant_summary/tags/relevance_score/text_status, or NONE
-- of them -- never a mix. All rows below except the deliberate 'bill-stub-nomatch'
-- lightweight stub are fully analyzed; that one row has none of these fields set,
-- representing a bill that has never been through AI analysis (used to exercise the
-- 'Enable full analysis' / promote path locally).
INSERT OR IGNORE INTO bills (id, bill_number, title, state, status, session, abstract, tenant_summary, tags, priority, sponsor, sponsor_party, last_action, last_action_date, history, state_link, committee, co_sponsors, relevance_score, match_type, ai_processed_at, text_status, year_start, year_end, created_at, updated_at) VALUES
  ('bill-voter-id', 'HB 5042', 'An Act Relating to Elections - Voter Identification Requirements', 'RI', '2', '2025-2026', 'Requires presentation of valid photo identification at polling places for all elections.', 'Strengthens voter identification requirements at polling places by mandating government-issued photo ID. Includes provisions for free state ID cards and provisional ballot procedures for voters without ID. Creates a voter education campaign about new requirements.', '["Voter ID","Election Security","Voter Access"]', 'high', 'Rep. Patricia Morgan', 'Republican', 'Referred to House Judiciary Committee', '2026-02-15', '[{"date":"2026-01-10","action":"Introduced","chamber":"House"},{"date":"2026-01-12","action":"Referred to House Judiciary Committee","chamber":"House"},{"date":"2026-02-01","action":"Committee hearing scheduled","chamber":"House"},{"date":"2026-02-15","action":"Hearing held; testimony received","chamber":"House"}]', 'https://www.rilegislature.gov/billtracker', 'House Judiciary', '[{"name":"Rep. Michael Chippendale","party":"Republican","role":"Rep","district":"40","url":null},{"name":"Rep. Brian Newberry","party":"Republican","role":"Rep","district":"48","url":null}]', 9, 'keyword', '2026-02-15 16:00:00', 'in_r2', 2025, 2026, '2026-01-10 10:00:00', '2026-02-15 16:00:00'),
  ('bill-early-vote', 'SB 2218', 'An Act Relating to Elections - Early Voting Centers', 'RI', '2', '2025-2026', 'Establishes permanent early voting centers in every municipality.', 'Mandates establishment of at least one permanent early voting center per municipality, open for 15 days before any general election. Requires extended hours including evenings and weekends. Appropriates $2.8M for facility setup and staffing. Modifies existing mail ballot deadlines to accommodate early voting schedule.', '["Early Voting","Voter Access","Election Administration"]', 'high', 'Sen. Dawn Euer', 'Democrat', 'Passed Senate; referred to House', '2026-03-20', '[{"date":"2026-01-15","action":"Introduced","chamber":"Senate"},{"date":"2026-01-20","action":"Referred to Senate Judiciary","chamber":"Senate"},{"date":"2026-02-10","action":"Committee hearing held","chamber":"Senate"},{"date":"2026-02-28","action":"Recommended for passage","chamber":"Senate"},{"date":"2026-03-05","action":"Floor debate","chamber":"Senate"},{"date":"2026-03-10","action":"Passed Senate 24-12","chamber":"Senate"},{"date":"2026-03-20","action":"Referred to House State Government","chamber":"House"}]', 'https://www.rilegislature.gov/billtracker', 'House State Government', '[{"name":"Sen. Valarie Lawson","party":"Democrat","role":"Sen","district":"14","url":null},{"name":"Sen. Tiara Mack","party":"Democrat","role":"Sen","district":"6","url":null},{"name":"Sen. Ana Quezada","party":"Democrat","role":"Sen","district":"2","url":null}]', 10, 'keyword', '2026-03-20 14:00:00', 'in_r2', 2025, 2026, '2026-01-15 10:00:00', '2026-03-20 14:00:00'),
  ('bill-cyber', 'HB 6133', 'An Act Relating to Elections - Cybersecurity Standards', 'RI', '2', '2025-2026', 'Establishes cybersecurity standards for election infrastructure.', 'Creates mandatory cybersecurity standards for all election systems including voter registration databases, electronic poll books, and tabulation equipment. Requires annual penetration testing, multi-factor authentication for administrative access, and incident reporting within 24 hours. Establishes an Election Security Advisory Board.', '["Election Security","Cybersecurity","Election Administration"]', 'medium', 'Rep. Jason Knight', 'Democrat', 'Committee hearing held', '2026-03-01', '[{"date":"2026-02-01","action":"Introduced","chamber":"House"},{"date":"2026-02-05","action":"Referred to House Innovation, Internet & Technology","chamber":"House"},{"date":"2026-03-01","action":"Committee hearing held","chamber":"House"}]', 'https://www.rilegislature.gov/billtracker', 'House Innovation, Internet & Technology', '[]', 8, 'keyword', '2026-03-01 15:00:00', 'in_r2', 2025, 2026, '2026-02-01 10:00:00', '2026-03-01 15:00:00'),
  ('bill-rcv', 'HB 5500', 'An Act Relating to Elections - Ranked Choice Voting Pilot Program', 'RI', '1', '2025-2026', 'Creates a pilot program for ranked choice voting in municipal elections.', 'Authorizes municipalities to opt into ranked choice voting for local elections through 2028. Requires participating municipalities to conduct voter education campaigns. State Board of Elections to certify RCV-compatible tabulation systems. Includes $500K appropriation for implementation grants.', '["Ranked Choice Voting","Election Reform","Municipal Elections"]', 'low', 'Rep. David Morales', 'Democrat', 'Introduced; referred to committee', '2026-01-20', '[{"date":"2026-01-18","action":"Introduced","chamber":"House"},{"date":"2026-01-20","action":"Referred to House State Government & Elections","chamber":"House"}]', 'https://www.rilegislature.gov/billtracker', 'House State Government & Elections', '[{"name":"Rep. Liana Cassar","party":"Democrat","role":"Rep","district":"66","url":null}]', 5, 'keyword', '2026-01-20 12:00:00', 'in_r2', 2025, 2026, '2026-01-18 10:00:00', '2026-01-20 12:00:00'),
  ('bill-training', 'SB 2500', 'An Act Relating to Elections - Election Official Training and Certification', 'RI', '4', '2025-2026', 'Requires mandatory training and certification for all election officials.', 'Establishes a comprehensive training and certification program for election officials administered by the Board of Elections. Requires 20 hours of initial training and 8 hours of annual continuing education. Covers election law, technology, accessibility, and emergency procedures. Creates a tiered certification system.', '["Election Officials & Administration","Training","Certification"]', 'high', 'Sen. Mark McKenney', 'Democrat', 'Signed into law', '2026-04-15', '[{"date":"2025-11-15","action":"Introduced","chamber":"Senate"},{"date":"2025-12-01","action":"Referred to Senate Judiciary","chamber":"Senate"},{"date":"2026-01-10","action":"Committee hearing held","chamber":"Senate"},{"date":"2026-01-25","action":"Passed Senate unanimously","chamber":"Senate"},{"date":"2026-02-10","action":"Referred to House State Government","chamber":"House"},{"date":"2026-03-01","action":"Committee hearing held","chamber":"House"},{"date":"2026-03-15","action":"Passed House 68-2","chamber":"House"},{"date":"2026-04-01","action":"Enrolled; sent to Governor","chamber":""},{"date":"2026-04-15","action":"Signed by Governor","chamber":""}]', 'https://www.rilegislature.gov/billtracker', '', '[{"name":"Sen. Hanna Gallo","party":"Democrat","role":"Sen","district":"27","url":null},{"name":"Sen. Lou DiPalma","party":"Democrat","role":"Sen","district":"12","url":null}]', 10, 'keyword', '2026-04-15 10:00:00', 'in_r2', 2025, 2026, '2025-11-15 10:00:00', '2026-04-15 10:00:00'),
  ('bill-mail', 'SB 2750', 'An Act Relating to Elections - Mail Ballot Processing', 'RI', '2', '2025-2026', 'Allows pre-processing of mail ballots before election day.', 'Permits election officials to begin opening and scanning mail ballots 7 days before election day while keeping results sealed until polls close. Establishes bipartisan observer requirements during pre-processing. Requires chain-of-custody documentation and video monitoring of processing areas.', '["Mail Voting","Election Administration","Ballot Processing"]', 'medium', 'Sen. Alana DiMario', 'Democrat', 'In Senate Judiciary', '2026-02-20', '[{"date":"2026-01-20","action":"Introduced","chamber":"Senate"},{"date":"2026-01-25","action":"Referred to Senate Judiciary","chamber":"Senate"},{"date":"2026-02-20","action":"Committee hearing scheduled","chamber":"Senate"}]', 'https://www.rilegislature.gov/billtracker', 'Senate Judiciary', '[]', 9, 'keyword', '2026-02-20 12:00:00', 'in_r2', 2025, 2026, '2026-01-20 10:00:00', '2026-02-20 12:00:00'),
  ('bill-access', 'HB 5888', 'An Act Relating to Elections - Polling Place Accessibility', 'RI', '2', '2025-2026', 'Strengthens ADA compliance requirements for polling locations.', 'Requires all polling places to meet enhanced accessibility standards beyond minimum ADA requirements. Mandates accessible ballot marking devices at every location, audio ballot options, and curbside voting. Creates an accessibility audit program with annual inspections. Provides funding for municipalities to upgrade facilities.', '["Voter Access","ADA Compliance","Election Administration"]', NULL, 'Rep. Justine Caldwell', 'Democrat', 'Committee hearing held', '2026-03-10', '[{"date":"2026-02-10","action":"Introduced","chamber":"House"},{"date":"2026-02-15","action":"Referred to House Health & Human Services","chamber":"House"},{"date":"2026-03-10","action":"Committee hearing held","chamber":"House"}]', 'https://www.rilegislature.gov/billtracker', 'House Health & Human Services', '[{"name":"Rep. Karen Alzate","party":"Democrat","role":"Rep","district":"60","url":null}]', 7, 'keyword', '2026-03-10 14:00:00', 'in_r2', 2025, 2026, '2026-02-10 10:00:00', '2026-03-10 14:00:00'),
  ('bill-edr', 'SB 2900', 'An Act Relating to Elections - Same-Day Voter Registration', 'RI', '1', '2025-2026', 'Allows voter registration on election day at polling places.', 'Permits eligible citizens to register and vote at their polling place on election day. Requires provisional ballot for same-day registrants pending verification. Modifies existing registration deadline provisions. Appropriates funds for additional poll worker training.', '["Voter Registration","Voter Access","Election Reform"]', NULL, 'Sen. Jonathon Acosta', 'Democrat', 'Introduced', '2026-03-01', '[{"date":"2026-03-01","action":"Introduced","chamber":"Senate"}]', 'https://www.rilegislature.gov/billtracker', '', '[]', 6, 'keyword', '2026-03-01 10:00:00', 'in_r2', 2025, 2026, '2026-03-01 10:00:00', '2026-03-01 10:00:00'),
  ('bill-redistrict', 'HJ 5001', 'Joint Resolution - Independent Redistricting Commission', 'RI', '2', '2025-2026', 'Constitutional amendment establishing an independent redistricting commission.', 'Proposes a constitutional amendment creating a 9-member independent redistricting commission to draw legislative and congressional district boundaries. Commissioners selected through an application process with demographic diversity requirements. Prohibits partisan gerrymandering. Requires public hearings and transparent mapping criteria.', '["Redistricting","Election Reform","Constitutional Amendment"]', 'low', 'Rep. June Speakman', 'Democrat', 'Committee study recommended', '2026-02-28', '[{"date":"2026-01-05","action":"Introduced","chamber":"House"},{"date":"2026-01-10","action":"Referred to House Judiciary","chamber":"House"},{"date":"2026-02-15","action":"Committee hearing held","chamber":"House"},{"date":"2026-02-28","action":"Recommended for further study","chamber":"House"}]', 'https://www.rilegislature.gov/billtracker', 'House Judiciary', '[]', 4, 'keyword', '2026-02-28 14:00:00', 'in_r2', 2025, 2026, '2026-01-05 10:00:00', '2026-02-28 14:00:00'),
  ('bill-campaign', 'HB 6200', 'An Act Relating to Campaign Finance - Electronic Filing', 'RI', '2', '2025-2026', 'Requires electronic filing of campaign finance reports.', 'Mandates electronic filing for all campaign finance reports and disclosures. Requires real-time disclosure of contributions over $1,000. Creates a searchable public database of campaign finance data. Establishes penalties for late or incomplete filings.', '["Campaign Finance","Transparency","Election Administration"]', NULL, 'Rep. Gregg Amore', 'Democrat', 'Passed House; in Senate', '2026-04-01', '[{"date":"2026-01-22","action":"Introduced","chamber":"House"},{"date":"2026-01-28","action":"Referred to House Judiciary","chamber":"House"},{"date":"2026-02-20","action":"Committee hearing held","chamber":"House"},{"date":"2026-03-10","action":"Passed House 62-8","chamber":"House"},{"date":"2026-04-01","action":"Referred to Senate Judiciary","chamber":"Senate"}]', 'https://www.rilegislature.gov/billtracker', 'Senate Judiciary', '[]', 5, 'keyword', '2026-04-01 12:00:00', 'in_r2', 2025, 2026, '2026-01-22 10:00:00', '2026-04-01 12:00:00'),
  ('bill-pollworker', 'HB 5300', 'An Act Relating to Elections - Poll Worker Compensation', 'RI', '4', '2025-2026', 'Increases compensation for poll workers and election officials.', 'Raises minimum poll worker pay from $75 to $200 per election day. Creates tiered compensation for training completion. Establishes a recruitment bonus program for bilingual poll workers. Appropriates $1.2M annually.', '["Election Officials & Administration","Poll Workers","Compensation"]', 'medium', 'Rep. Marcia Ranglin-Vassell', 'Democrat', 'Signed into law', '2026-05-01', '[{"date":"2025-12-01","action":"Introduced","chamber":"House"},{"date":"2025-12-10","action":"Referred to House Finance","chamber":"House"},{"date":"2026-01-15","action":"Committee hearing held","chamber":"House"},{"date":"2026-02-01","action":"Passed House 71-0","chamber":"House"},{"date":"2026-02-15","action":"Referred to Senate Finance","chamber":"Senate"},{"date":"2026-03-05","action":"Committee hearing held","chamber":"Senate"},{"date":"2026-03-20","action":"Passed Senate 35-3","chamber":"Senate"},{"date":"2026-04-15","action":"Enrolled","chamber":""},{"date":"2026-05-01","action":"Signed by Governor","chamber":""}]', 'https://www.rilegislature.gov/billtracker', '', '[{"name":"Rep. Jose Batista","party":"Democrat","role":"Rep","district":"12","url":null}]', 8, 'keyword', '2026-05-01 10:00:00', 'in_r2', 2025, 2026, '2025-12-01 10:00:00', '2026-05-01 10:00:00'),
  ('bill-rolls', 'SB 2100', 'An Act Relating to Elections - Voter Roll Maintenance', 'RI', '2', '2025-2026', 'Updates procedures for maintaining voter registration rolls.', 'Modernizes voter roll maintenance procedures including automated address updates via USPS data, cross-state duplicate checking via ERIC, and standardized list maintenance timelines. Prohibits mass purges within 90 days of an election. Requires public notice before any systematic removal program.', '["Voter Registration","Election Security","Data Management"]', NULL, 'Sen. Frank Lombardi', 'Democrat', 'In committee', '2026-02-10', '[{"date":"2026-01-08","action":"Introduced","chamber":"Senate"},{"date":"2026-01-15","action":"Referred to Senate Judiciary","chamber":"Senate"},{"date":"2026-02-10","action":"Committee hearing scheduled","chamber":"Senate"}]', 'https://www.rilegislature.gov/billtracker', 'Senate Judiciary', '[]', 7, 'keyword', '2026-02-10 12:00:00', 'in_r2', 2025, 2026, '2026-01-08 10:00:00', '2026-02-10 12:00:00'),
  ('bill-stub-nomatch', 'SB 2411', 'An Act Relating to Elections - Municipal Election Consolidation Study', 'RI', '1', '2025-2026', 'Directs a legislative study on consolidating municipal election dates.', NULL, '[]', NULL, 'Sen. Louis DiPalma', 'Democrat', 'Introduced; referred to committee', '2026-03-05', '[{"date":"2026-03-05","action":"Introduced","chamber":"Senate"},{"date":"2026-03-06","action":"Referred to Senate Judiciary","chamber":"Senate"}]', 'https://www.rilegislature.gov/billtracker', 'Senate Judiciary', '[]', NULL, NULL, NULL, NULL, 2025, 2026, '2026-03-05 10:00:00', '2026-03-06 09:00:00');

-- === BILL TEXTS ===
INSERT OR IGNORE INTO bill_texts (id, bill_id, doc_id, type, date, mime, text_hash, state_link) VALUES
  ('bt-1', 'bill-voter-id', 10001, 'Introduced', '2026-01-10', 'application/pdf', 'hash1', 'https://www.rilegislature.gov/docs/HB5042-intro.pdf'),
  ('bt-2', 'bill-early-vote', 10002, 'Introduced', '2026-01-15', 'application/pdf', 'hash2', 'https://www.rilegislature.gov/docs/SB2218-intro.pdf'),
  ('bt-3', 'bill-early-vote', 10003, 'Committee Amendment', '2026-02-25', 'application/pdf', 'hash3', 'https://www.rilegislature.gov/docs/SB2218-amend.pdf'),
  ('bt-4', 'bill-cyber', 10004, 'Introduced', '2026-02-01', 'application/pdf', 'hash4', 'https://www.rilegislature.gov/docs/HB6133-intro.pdf'),
  ('bt-5', 'bill-training', 10005, 'Introduced', '2025-11-15', 'application/pdf', 'hash5', 'https://www.rilegislature.gov/docs/SB2500-intro.pdf'),
  ('bt-6', 'bill-training', 10006, 'Enrolled', '2026-04-01', 'application/pdf', 'hash6', 'https://www.rilegislature.gov/docs/SB2500-enrolled.pdf'),
  ('bt-7', 'bill-mail', 10007, 'Introduced', '2026-01-20', 'application/pdf', 'hash7', NULL),
  ('bt-8', 'bill-campaign', 10008, 'Introduced', '2026-01-22', 'application/pdf', 'hash8', NULL),
  ('bt-9', 'bill-campaign', 10009, 'Engrossed', '2026-03-10', 'application/pdf', 'hash9', NULL),
  ('bt-10', 'bill-pollworker', 10010, 'Introduced', '2025-12-01', 'application/pdf', 'hash10', NULL),
  ('bt-11', 'bill-pollworker', 10011, 'Enrolled', '2026-04-15', 'application/pdf', 'hash11', NULL);

-- === CALENDAR EVENTS (HEARINGS) ===
-- Schema note: hearings moved from the old bill_calendar/bill_supplements tables
-- to calendar_events (+ calendar_event_bills join). uid is unique/not-null.
INSERT OR IGNORE INTO calendar_events (id, uid, bill_id, source, sequence, date, time, location, description, status) VALUES
  ('cal-1', 'seed-eh1', 'bill-voter-id', 'hearing', 0, '2026-02-01', '10:00 AM', 'Room 313, State House', 'House Judiciary — public hearing on HB 5042', 'confirmed'),
  ('cal-2', 'seed-eh2', 'bill-voter-id', 'hearing', 0, '2026-02-15', '2:00 PM', 'Room 313, State House', 'House Judiciary — continued hearing; testimony from clerks association', 'confirmed'),
  ('cal-3', 'seed-eh3', 'bill-early-vote', 'hearing', 0, '2026-02-10', '10:00 AM', 'Lounge A, State House', 'Senate Judiciary — public hearing on SB 2218', 'confirmed'),
  ('cal-4', 'seed-eh4', 'bill-early-vote', 'hearing', 0, '2026-04-01', '1:00 PM', 'Room 205, State House', 'House State Government — committee hearing on SB 2218 Sub A', 'confirmed'),
  ('cal-5', 'seed-eh5', 'bill-cyber', 'hearing', 0, '2026-03-01', '3:00 PM', 'Room 101, State House', 'House Innovation — initial hearing; invited testimony from CISA', 'confirmed'),
  ('cal-6', 'seed-eh6', 'bill-training', 'hearing', 0, '2026-01-10', '10:00 AM', 'Lounge A, State House', 'Senate Judiciary — public hearing', 'confirmed'),
  ('cal-7', 'seed-eh7', 'bill-training', 'hearing', 0, '2026-03-01', '2:00 PM', 'Room 205, State House', 'House State Government — committee hearing', 'confirmed'),
  ('cal-8', 'seed-eh8', 'bill-mail', 'hearing', 0, '2026-02-20', '9:30 AM', 'Lounge A, State House', 'Senate Judiciary — hearing scheduled', 'confirmed');

INSERT OR IGNORE INTO calendar_event_bills (event_id, bill_id) VALUES
  ('cal-1', 'bill-voter-id'),
  ('cal-2', 'bill-voter-id'),
  ('cal-3', 'bill-early-vote'),
  ('cal-4', 'bill-early-vote'),
  ('cal-5', 'bill-cyber'),
  ('cal-6', 'bill-training'),
  ('cal-7', 'bill-training'),
  ('cal-8', 'bill-mail');

-- === MEMBER VOTES ===
INSERT OR IGNORE INTO member_votes (id, user_id, bill_id, position, created_at) VALUES
  -- Voter ID bill: controversial
  ('mv-1', 'user-maria', 'bill-voter-id', 'oppose', '2026-01-12 14:00:00'),
  ('mv-2', 'user-david', 'bill-voter-id', 'oppose', '2026-01-13 09:00:00'),
  ('mv-3', 'user-sarah', 'bill-voter-id', 'neutral', '2026-01-14 11:00:00'),
  ('mv-4', 'user-james', 'bill-voter-id', 'oppose', '2026-01-15 08:00:00'),
  ('mv-5', 'user-linda', 'bill-voter-id', 'oppose', '2026-01-16 10:00:00'),
  ('mv-6', 'user-mike', 'bill-voter-id', 'support', '2026-01-17 09:30:00'),
  ('mv-7', 'user-tom', 'bill-voter-id', 'oppose', '2026-01-18 16:00:00'),
  -- Early voting: broad support
  ('mv-8', 'user-maria', 'bill-early-vote', 'support', '2026-01-20 10:00:00'),
  ('mv-9', 'user-david', 'bill-early-vote', 'support', '2026-01-21 09:00:00'),
  ('mv-10', 'user-sarah', 'bill-early-vote', 'support', '2026-01-22 14:00:00'),
  ('mv-11', 'user-james', 'bill-early-vote', 'support', '2026-02-01 08:00:00'),
  ('mv-12', 'user-linda', 'bill-early-vote', 'support', '2026-02-02 11:00:00'),
  ('mv-13', 'user-mike', 'bill-early-vote', 'neutral', '2026-02-03 09:00:00'),
  ('mv-14', 'user-tom', 'bill-early-vote', 'support', '2026-02-04 10:00:00'),
  ('mv-15', 'user-rachel', 'bill-early-vote', 'support', '2026-02-10 15:00:00'),
  -- Cybersecurity: mixed
  ('mv-16', 'user-david', 'bill-cyber', 'support', '2026-02-05 09:00:00'),
  ('mv-17', 'user-tom', 'bill-cyber', 'support', '2026-02-06 14:00:00'),
  ('mv-18', 'user-james', 'bill-cyber', 'support', '2026-02-08 10:00:00'),
  ('mv-19', 'user-mike', 'bill-cyber', 'support', '2026-02-10 09:00:00'),
  -- Training bill: unanimous
  ('mv-20', 'user-maria', 'bill-training', 'support', '2025-12-01 10:00:00'),
  ('mv-21', 'user-david', 'bill-training', 'support', '2025-12-02 09:00:00'),
  ('mv-22', 'user-sarah', 'bill-training', 'support', '2025-12-03 11:00:00'),
  ('mv-23', 'user-james', 'bill-training', 'support', '2025-12-04 08:00:00'),
  ('mv-24', 'user-linda', 'bill-training', 'support', '2025-12-05 14:00:00'),
  ('mv-25', 'user-tom', 'bill-training', 'support', '2025-12-06 10:00:00'),
  ('mv-26', 'user-mike', 'bill-training', 'support', '2025-12-10 09:00:00'),
  -- Mail ballot
  ('mv-27', 'user-maria', 'bill-mail', 'support', '2026-01-25 10:00:00'),
  ('mv-28', 'user-david', 'bill-mail', 'support', '2026-01-26 09:00:00'),
  ('mv-29', 'user-sarah', 'bill-mail', 'support', '2026-01-28 14:00:00'),
  ('mv-30', 'user-james', 'bill-mail', 'neutral', '2026-01-30 08:00:00'),
  -- Poll worker pay
  ('mv-31', 'user-maria', 'bill-pollworker', 'support', '2025-12-05 10:00:00'),
  ('mv-32', 'user-sarah', 'bill-pollworker', 'support', '2025-12-08 14:00:00'),
  ('mv-33', 'user-james', 'bill-pollworker', 'support', '2025-12-10 08:00:00'),
  ('mv-34', 'user-linda', 'bill-pollworker', 'support', '2025-12-12 11:00:00'),
  ('mv-35', 'user-mike', 'bill-pollworker', 'support', '2025-12-15 09:00:00'),
  -- Accessibility
  ('mv-36', 'user-linda', 'bill-access', 'support', '2026-02-12 10:00:00'),
  ('mv-37', 'user-sarah', 'bill-access', 'support', '2026-02-14 09:00:00'),
  ('mv-38', 'user-rachel', 'bill-access', 'support', '2026-03-01 14:00:00');

-- === OFFICIAL POSITIONS ===
INSERT OR IGNORE INTO official_positions (id, bill_id, position, notes, set_by) VALUES
  ('op-1', 'bill-voter-id', 'Oppose', 'Creates barriers for eligible voters; free ID program is underfunded', 'user-maria'),
  ('op-2', 'bill-early-vote', 'Support', 'Critical infrastructure for voter access; association testified in favor', 'user-maria'),
  ('op-3', 'bill-training', 'Support', 'Core mission alignment; we helped draft the curriculum framework', 'user-maria'),
  ('op-4', 'bill-cyber', 'Support', 'Security is foundational; requesting seat on Advisory Board', 'user-david'),
  ('op-5', 'bill-pollworker', 'Support', 'Long overdue; recruitment has been our #1 challenge', 'user-maria'),
  ('op-6', 'bill-mail', 'Support', 'Pre-processing is essential for timely results', 'user-david');

-- === COMMENTS ===
INSERT OR IGNORE INTO comments (id, bill_id, user_id, content, created_at) VALUES
  -- Voter ID comments (heated discussion)
  ('c-1', 'bill-voter-id', 'user-maria', '<p>I spoke with the sponsor''s office — they''re not budging on the photo ID requirement. Our testimony focused on the <strong>provisional ballot</strong> provisions being inadequate.</p>', '2026-01-15 14:00:00'),
  ('c-2', 'bill-voter-id', 'user-david', '<p>The fiscal note estimates $1.8M for the free ID program but doesn''t account for outreach costs. I''ve drafted a memo outlining the gaps.</p>', '2026-01-16 10:00:00'),
  ('c-3', 'bill-voter-id', 'user-sarah', '<p>From a clerk''s perspective, the <em>implementation timeline is unrealistic</em>. We''d need at least 18 months to train staff and set up verification systems.</p>', '2026-01-18 11:30:00'),
  ('c-4', 'bill-voter-id', 'user-james', '<p>Agreed with Sarah. Cranston alone would need 3 additional staff for the ID verification line. Has anyone modeled the wait time impact?</p>', '2026-01-19 09:00:00'),
  ('c-5', 'bill-voter-id', 'user-mike', '<p>I actually think there''s room for compromise here. The free ID provision is a good start — we should push for <strong>expanded acceptable IDs</strong> rather than opposing outright.</p>', '2026-01-20 15:00:00'),
  ('c-6', 'bill-voter-id', 'user-tom', '<p>Mike raises a fair point, but the data from other states shows voter ID laws disproportionately affect elderly and low-income voters even with free ID programs. <span data-type="mention" data-id="user:user-david" data-label="David Park">@David Park</span> can you share that ACLU analysis?</p>', '2026-01-21 16:00:00'),

  -- Early voting comments (collaborative)
  ('c-7', 'bill-early-vote', 'user-maria', '<p>Great news — the Senate passed this 24-12. <span data-type="mention" data-id="role:role-leg" data-label="Legislative Committee">@Legislative Committee</span> please review the amended version before the House hearing.</p>', '2026-03-12 10:00:00'),
  ('c-8', 'bill-early-vote', 'user-david', '<p>The amendment added a requirement for at least one early voting center per 25,000 residents in cities over 50K. This is actually better than the original.</p>', '2026-03-13 09:00:00'),
  ('c-9', 'bill-early-vote', 'user-sarah', '<p>Warwick is already planning for this. We have a community center that would work perfectly. The $2.8M appropriation should cover most setup costs.</p>', '2026-03-14 14:00:00'),
  ('c-10', 'bill-early-vote', 'user-linda', '<p>Providence will need at least 3 centers based on the population formula. I''m meeting with the city manager next week to discuss locations.</p>', '2026-03-15 11:00:00'),
  ('c-11', 'bill-early-vote', 'user-tom', '<p><span data-type="mention" data-id="user:user-maria" data-label="Maria Chen">@Maria Chen</span> should we prepare testimony for the House hearing? I can draft talking points based on our early voting survey data.</p>', '2026-03-18 10:00:00'),
  ('c-12', 'bill-early-vote', 'user-maria', '<p>Yes please, <span data-type="mention" data-id="user:user-tom" data-label="Tom Brennan">@Tom Brennan</span>. Let''s also include the staffing estimates from <span data-type="mention" data-id="user:user-sarah" data-label="Sarah Wright">@Sarah Wright</span> and <span data-type="mention" data-id="user:user-linda" data-label="Linda Nguyen">@Linda Nguyen</span>.</p>', '2026-03-18 10:30:00'),

  -- Cybersecurity comments
  ('c-13', 'bill-cyber', 'user-david', '<p>The 24-hour incident reporting requirement is concerning. Some incidents take days to fully assess. I''ve flagged this with the sponsor.</p>', '2026-02-10 09:00:00'),
  ('c-14', 'bill-cyber', 'user-james', '<p>The <strong>multi-factor authentication</strong> requirement is reasonable but will require budget for hardware tokens. Our current vendor quoted $15/user/year.</p>', '2026-02-12 10:00:00'),
  ('c-15', 'bill-cyber', 'user-mike', '<p>I attended the CISA briefing last week. They strongly support this bill and offered to provide free penetration testing for the first two years.</p>', '2026-03-02 14:00:00'),
  ('c-16', 'bill-cyber', 'user-tom', '<p><span data-type="mention" data-id="role:role-tech" data-label="Technology & Modernization">@Technology & Modernization</span> — can we schedule a working group to develop our recommended amendments before the next hearing?</p>', '2026-03-05 16:00:00'),

  -- Training bill comments
  ('c-17', 'bill-training', 'user-maria', '<p>This is now law! Huge win for our association. <span data-type="mention" data-id="role:role-exec" data-label="Executive Board">@Executive Board</span> — we should issue a statement today.</p>', '2026-04-15 12:00:00'),
  ('c-18', 'bill-training', 'user-david', '<p>I''ll coordinate with the Board of Elections on the curriculum development. They want our input on the <em>accessibility</em> and <em>emergency procedures</em> modules.</p>', '2026-04-16 09:00:00'),
  ('c-19', 'bill-training', 'user-sarah', '<p>Already shared this with my staff. The 20-hour initial training is manageable — we currently do about 12 hours informally anyway.</p>', '2026-04-16 14:00:00'),

  -- Mail ballot comments
  ('c-20', 'bill-mail', 'user-maria', '<p>The 7-day pre-processing window is exactly what we''ve been asking for. This would have saved us significant stress in November 2024.</p>', '2026-01-28 10:00:00'),
  ('c-21', 'bill-mail', 'user-james', '<p>The chain-of-custody documentation requirements are thorough but doable. My main concern is the video monitoring costs — any estimate on that?</p>', '2026-02-01 09:00:00'),

  -- Poll worker comments
  ('c-22', 'bill-pollworker', 'user-sarah', '<p>The bilingual recruitment bonus is a game changer. We struggled to find Spanish-speaking poll workers last cycle.</p>', '2025-12-10 14:00:00'),
  ('c-23', 'bill-pollworker', 'user-linda', '<p>Providence recruited 40% more poll workers after the city increased pay to $175. This statewide increase to $200 will make a real difference.</p>', '2025-12-15 11:00:00'),
  ('c-24', 'bill-pollworker', 'user-mike', '<p>Newport had 6 vacancies last election. This plus the training certification bill should help us professionalize the role.</p>', '2025-12-18 09:00:00'),

  -- Accessibility
  ('c-25', 'bill-access', 'user-linda', '<p>The annual accessibility audit is important but municipalities need funding support. The bill includes grants but the amount isn''t specified.</p>', '2026-02-15 10:00:00'),
  ('c-26', 'bill-access', 'user-rachel', '<p>I''ve been working with disability advocacy groups on this. The ballot marking device requirement at <strong>every</strong> location is the key provision.</p>', '2026-03-01 14:00:00');

-- === COMMENT REACTIONS ===
INSERT OR IGNORE INTO comment_reactions (id, comment_id, user_id, emoji, created_at) VALUES
  ('cr-1', 'c-1', 'user-david', '👍', '2026-01-15 15:00:00'),
  ('cr-2', 'c-1', 'user-tom', '👍', '2026-01-15 16:00:00'),
  ('cr-3', 'c-3', 'user-james', '💯', '2026-01-18 12:00:00'),
  ('cr-4', 'c-3', 'user-maria', '👍', '2026-01-18 14:00:00'),
  ('cr-5', 'c-7', 'user-david', '🎉', '2026-03-12 10:30:00'),
  ('cr-6', 'c-7', 'user-sarah', '🎉', '2026-03-12 11:00:00'),
  ('cr-7', 'c-7', 'user-tom', '🎉', '2026-03-12 11:30:00'),
  ('cr-8', 'c-17', 'user-david', '🎉', '2026-04-15 12:30:00'),
  ('cr-9', 'c-17', 'user-sarah', '🎉', '2026-04-15 13:00:00'),
  ('cr-10', 'c-17', 'user-tom', '👍', '2026-04-15 13:30:00'),
  ('cr-11', 'c-17', 'user-james', '🎉', '2026-04-15 14:00:00'),
  ('cr-12', 'c-22', 'user-linda', '👍', '2025-12-10 15:00:00'),
  ('cr-13', 'c-23', 'user-sarah', '💯', '2025-12-15 12:00:00'),
  ('cr-14', 'c-5', 'user-sarah', '🤔', '2026-01-20 16:00:00'),
  ('cr-15', 'c-12', 'user-tom', '👍', '2026-03-18 11:00:00');

-- === FEED EVENTS ===
INSERT OR IGNORE INTO feed_events (id, type, bill_id, user_id, metadata, created_at) VALUES
  ('fe-1', 'priority_set', 'bill-voter-id', 'user-maria', '{"priority":"high","billNumber":"HB 5042","billTitle":"Voter Identification Requirements"}', '2026-01-12 10:00:00'),
  ('fe-2', 'position_set', 'bill-voter-id', 'user-maria', '{"position":"Oppose","billNumber":"HB 5042","billTitle":"Voter Identification Requirements"}', '2026-01-12 10:30:00'),
  ('fe-3', 'comment_added', 'bill-voter-id', 'user-maria', '{"preview":"I spoke with the sponsor''s office — they''re not budging on the photo ID requirement.","billNumber":"HB 5042","billTitle":"Voter Identification Requirements"}', '2026-01-15 14:00:00'),
  ('fe-4', 'priority_set', 'bill-early-vote', 'user-maria', '{"priority":"high","billNumber":"SB 2218","billTitle":"Early Voting Centers"}', '2026-01-20 09:00:00'),
  ('fe-5', 'position_set', 'bill-early-vote', 'user-maria', '{"position":"Support","billNumber":"SB 2218","billTitle":"Early Voting Centers"}', '2026-01-20 09:30:00'),
  ('fe-6', 'comment_added', 'bill-early-vote', 'user-maria', '{"preview":"Great news — the Senate passed this 24-12.","billNumber":"SB 2218","billTitle":"Early Voting Centers"}', '2026-03-12 10:00:00'),
  ('fe-7', 'comment_added', 'bill-early-vote', 'user-david', '{"preview":"The amendment added a requirement for at least one early voting center per 25,000 residents.","billNumber":"SB 2218","billTitle":"Early Voting Centers"}', '2026-03-13 09:00:00'),
  ('fe-8', 'position_set', 'bill-cyber', 'user-david', '{"position":"Support","billNumber":"HB 6133","billTitle":"Cybersecurity Standards"}', '2026-02-05 10:00:00'),
  ('fe-9', 'priority_set', 'bill-training', 'user-maria', '{"priority":"high","billNumber":"SB 2500","billTitle":"Election Official Training"}', '2025-12-01 09:00:00'),
  ('fe-10', 'position_set', 'bill-training', 'user-maria', '{"position":"Support","billNumber":"SB 2500","billTitle":"Election Official Training"}', '2025-12-01 09:30:00'),
  ('fe-11', 'comment_added', 'bill-training', 'user-maria', '{"preview":"This is now law! Huge win for our association.","billNumber":"SB 2500","billTitle":"Election Official Training"}', '2026-04-15 12:00:00'),
  ('fe-12', 'vote_milestone', 'bill-training', 'user-maria', '{"milestone":"7 votes","billNumber":"SB 2500","billTitle":"Election Official Training"}', '2025-12-10 09:30:00'),
  ('fe-13', 'position_set', 'bill-pollworker', 'user-maria', '{"position":"Support","billNumber":"HB 5300","billTitle":"Poll Worker Compensation"}', '2025-12-05 10:30:00'),
  ('fe-14', 'priority_set', 'bill-pollworker', 'user-maria', '{"priority":"medium","billNumber":"HB 5300","billTitle":"Poll Worker Compensation"}', '2025-12-05 10:00:00'),
  ('fe-15', 'comment_added', 'bill-cyber', 'user-tom', '{"preview":"Can we schedule a working group to develop our recommended amendments?","billNumber":"HB 6133","billTitle":"Cybersecurity Standards"}', '2026-03-05 16:00:00'),
  ('fe-16', 'position_set', 'bill-mail', 'user-david', '{"position":"Support","billNumber":"SB 2750","billTitle":"Mail Ballot Processing"}', '2026-01-26 09:30:00'),
  ('fe-17', 'priority_set', 'bill-mail', 'user-david', '{"priority":"medium","billNumber":"SB 2750","billTitle":"Mail Ballot Processing"}', '2026-01-26 09:00:00'),
  ('fe-18', 'comment_added', 'bill-access', 'user-rachel', '{"preview":"I''ve been working with disability advocacy groups on this.","billNumber":"HB 5888","billTitle":"Polling Place Accessibility"}', '2026-03-01 14:00:00');

-- === NOTES ===
INSERT OR IGNORE INTO notes (id, bill_id, user_id, content, created_at) VALUES
  ('n-1', 'bill-voter-id', 'user-david', 'Need to compile analysis of voter ID laws in neighboring states (CT, MA, NH). Check NCSL database.', '2026-01-14 10:00:00'),
  ('n-2', 'bill-early-vote', 'user-maria', 'Call Rep. Williams office re: House hearing schedule. Want to ensure our members can testify.', '2026-03-16 09:00:00'),
  ('n-3', 'bill-cyber', 'user-tom', 'Follow up with CISA regional director about free pen testing offer. Get details in writing for the committee.', '2026-03-03 14:00:00');
