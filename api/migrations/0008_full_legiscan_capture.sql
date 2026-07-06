-- api/migrations/0008_full_legiscan_capture.sql

-- All text versions for each bill (replaces single textR2Key)
CREATE TABLE IF NOT EXISTS bill_texts (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL UNIQUE,
  type_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  mime TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  r2_key TEXT,
  state_link TEXT,
  alt_state_link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hearing/calendar events per bill
CREATE TABLE IF NOT EXISTS bill_calendar (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  event_hash TEXT NOT NULL UNIQUE,
  type_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  location TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Amendment documents per bill
CREATE TABLE IF NOT EXISTS bill_amendments (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amendment_id INTEGER NOT NULL UNIQUE,
  adopted INTEGER NOT NULL DEFAULT 0,
  chamber TEXT,
  date TEXT,
  title TEXT,
  description TEXT,
  mime TEXT,
  url TEXT,
  state_link TEXT,
  amendment_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Supplement documents (fiscal notes, analyses) per bill
CREATE TABLE IF NOT EXISTS bill_supplements (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  supplement_id INTEGER NOT NULL UNIQUE,
  type_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  date TEXT,
  title TEXT,
  description TEXT,
  mime TEXT,
  url TEXT,
  state_link TEXT,
  supplement_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- New columns on bills
ALTER TABLE bills ADD COLUMN session_id INTEGER;
ALTER TABLE bills ADD COLUMN referrals TEXT;
ALTER TABLE bills ADD COLUMN progress TEXT;

CREATE INDEX idx_bill_texts_bill_id       ON bill_texts(bill_id);
CREATE INDEX idx_bill_calendar_bill_id    ON bill_calendar(bill_id);
CREATE INDEX idx_bill_amendments_bill_id  ON bill_amendments(bill_id);
CREATE INDEX idx_bill_supplements_bill_id ON bill_supplements(bill_id);
