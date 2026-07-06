CREATE TABLE calendar_events (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL UNIQUE,
  bill_id     TEXT,
  source      TEXT NOT NULL DEFAULT 'hearing',
  sequence    INTEGER NOT NULL DEFAULT 0,
  date        TEXT,
  time        TEXT,
  location    TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'confirmed',
  event_hash  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_calendar_events_bill ON calendar_events(bill_id);
