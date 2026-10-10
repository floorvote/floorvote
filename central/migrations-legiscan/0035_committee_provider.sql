-- Committees from providers (#299). The committees table has existed since
-- 0001 but the ingest never wrote it. It now gets a row for every committee a
-- bill is referred to, and bill_referrals.committee_id points at that row, so
-- one committee carries one name across bills.
--
-- Each row records the provider that wrote it, like bills, sessions, and
-- people (0025 and 0027). LegiScan's committees keep LegiScan's own ids, and
-- other providers mint theirs from provider_ids, so the two never collide.
--
-- Safe on every path: a fresh central and a LegiScan-only central have an
-- empty table, or rows a local LegiScan seed wrote, which the default labels
-- correctly. A fork's production has the same table from 0001, and nothing
-- here touches its council tables.
ALTER TABLE committees ADD COLUMN provider TEXT NOT NULL DEFAULT 'legiscan';

-- Fill the table from the referrals LegiScan bills already hold, which carry
-- LegiScan's committee ids and names, so existing bills point at real rows
-- without waiting for their next getBill. Each committee takes its name,
-- chamber, state, and session from its latest referral (SQLite fills the
-- other columns from the row that holds the MAX). Only LegiScan wrote
-- referral committee ids before now. Other providers wrote none, and every
-- table read here exists since 0001.
INSERT OR IGNORE INTO committees (committee_id, state, session_id, chamber, chamber_id, name, provider)
  SELECT committee_id, state, session_id, chamber, chamber_id, name, 'legiscan'
  FROM (
    SELECT r.committee_id, b.state, b.session_id,
      COALESCE(r.chamber, '') AS chamber, COALESCE(r.chamber_id, 0) AS chamber_id,
      TRIM(r.name) AS name, MAX(r.date) AS latest
    FROM bill_referrals r
    JOIN bills b ON b.bill_id = r.bill_id
    WHERE r.committee_id > 0 AND TRIM(COALESCE(r.name, '')) != '' AND b.provider = 'legiscan'
    GROUP BY r.committee_id
  );
