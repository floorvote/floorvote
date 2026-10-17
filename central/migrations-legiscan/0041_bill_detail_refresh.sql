-- The change_hash a bill's detail (actions, referrals, pending committee, sponsors, texts, votes) was last
-- fetched at. Every ingest that fetches the detail writes it. The master-list sync moves change_hash on a
-- bill nothing tracks without fetching its detail, so the two differ while that detail is stale
-- (lib/stubRefresh.ts). NULL means the detail was never fetched, or not known to be current.
ALTER TABLE bills ADD COLUMN detail_hash TEXT;

-- The change_hash a page view last queued a detail refresh for, and when. A lock on queuing again for the
-- same change, never read as a fetch. A refresh that never lands may be queued again once the lock is old.
ALTER TABLE bills ADD COLUMN detail_requested_hash TEXT;
ALTER TABLE bills ADD COLUMN detail_requested_at TEXT;

-- The refresh budget counts refreshes queued and not yet landed by when they were queued.
CREATE INDEX IF NOT EXISTS idx_bills_detail_requested_at ON bills(detail_requested_at) WHERE detail_requested_at IS NOT NULL;

-- Bills whose detail is known to be current start marked, so their first views spend no budget.
-- A tracked bill is ingested whenever it changes. A bill nothing tracks is current when its stored
-- actions reach its last action, which is the same test the bill page's gap notice makes.
-- The rest stay NULL and read as stale, including bills whose detail was never fetched.
UPDATE bills SET detail_hash = change_hash
WHERE detail_hash IS NULL
  AND (
    EXISTS (SELECT 1 FROM bill_tenants bt WHERE bt.bill_id = bills.bill_id AND bt.match_type IS NOT NULL)
    OR (
      EXISTS (SELECT 1 FROM bill_history h WHERE h.bill_id = bills.bill_id)
      AND (
        bills.last_action_date IS NULL
        OR bills.last_action_date <= (SELECT MAX(h.date) FROM bill_history h WHERE h.bill_id = bills.bill_id)
      )
    )
  );
