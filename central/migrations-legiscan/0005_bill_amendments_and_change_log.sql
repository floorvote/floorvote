CREATE TABLE IF NOT EXISTS bill_amendments (
  amendment_id  INTEGER PRIMARY KEY,
  bill_id       INTEGER NOT NULL,
  adopted       INTEGER NOT NULL DEFAULT 0,
  chamber       TEXT,
  date          TEXT,
  title         TEXT,
  description   TEXT,
  mime          TEXT,
  url           TEXT,
  state_link    TEXT,
  amendment_size INTEGER,
  amendment_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_bill_amendments_bill ON bill_amendments(bill_id);

CREATE TABLE IF NOT EXISTS bill_change_log (
  id           TEXT PRIMARY KEY,
  bill_id      INTEGER NOT NULL,
  change_type  TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  detail       TEXT,
  detected_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bill_change_log_bill_date ON bill_change_log(bill_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_bill_change_log_date ON bill_change_log(detected_at);
