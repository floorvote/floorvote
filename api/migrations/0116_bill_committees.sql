-- The committees a bill was referred to, mirrored from central's referrals and
-- pending committee (#471), for the bill list's Committee filter. One row per
-- committee per bill, keyed by central's committee id. is_current marks the
-- committee central names the bill pending in. The tenant replaces a bill's
-- rows on each write, as it does bill_subjects. A referral central names no
-- committee for has no row.
CREATE TABLE IF NOT EXISTS bill_committees (
  bill_id      TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  committee_id TEXT NOT NULL,
  state        TEXT NOT NULL,
  name         TEXT NOT NULL,
  chamber      TEXT,
  is_current   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bill_id, committee_id)
);

-- The filter looks a committee's bills up by its id.
CREATE INDEX IF NOT EXISTS idx_bill_committees_committee ON bill_committees(committee_id, bill_id);
