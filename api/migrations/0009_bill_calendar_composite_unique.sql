-- Fix bill_calendar unique constraint: event_hash is not globally unique across bills,
-- only unique per bill. Recreate the table with UNIQUE(bill_id, event_hash).

CREATE TABLE IF NOT EXISTS bill_calendar_new (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  event_hash TEXT NOT NULL,
  type_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  location TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bill_id, event_hash)
);

INSERT INTO bill_calendar_new SELECT * FROM bill_calendar;
DROP TABLE bill_calendar;
ALTER TABLE bill_calendar_new RENAME TO bill_calendar;
CREATE INDEX idx_bill_calendar_bill_id ON bill_calendar(bill_id);
