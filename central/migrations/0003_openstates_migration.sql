-- OpenStates migration: string IDs, new schema shape.
-- DESTRUCTIVE: drops bill data tables and recreates with new types.

-- Drop dependent tables first
DROP TABLE IF EXISTS bill_tenants;
DROP TABLE IF EXISTS bills;
DROP TABLE IF EXISTS legi_sessions;

-- New sessions table (replaces legi_sessions)
CREATE TABLE sessions (
  session_id          TEXT PRIMARY KEY,
  state               TEXT NOT NULL,
  identifier          TEXT NOT NULL,
  year_start          INTEGER NOT NULL,
  year_end            INTEGER NOT NULL,
  session_name        TEXT NOT NULL,
  classification      TEXT NOT NULL DEFAULT 'primary',
  is_current          INTEGER NOT NULL DEFAULT 0,
  sine_die            INTEGER NOT NULL DEFAULT 0,
  provider            TEXT NOT NULL DEFAULT 'openstates',
  active_sync_frequency_hours  INTEGER NOT NULL DEFAULT 24,
  recess_sync_frequency_hours  INTEGER NOT NULL DEFAULT 168,
  last_synced_at      TEXT,
  last_keyword_sweep_at TEXT
);

-- New bills table with string IDs
CREATE TABLE bills (
  bill_id             TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  state               TEXT NOT NULL,
  number              TEXT NOT NULL,
  title               TEXT NOT NULL,
  abstract            TEXT,
  status              TEXT,
  status_date         TEXT,
  last_action         TEXT,
  last_action_date    TEXT,
  openstates_url      TEXT,
  state_url           TEXT,
  provider_data       TEXT,
  text_r2_key         TEXT,
  text_hash           TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bills_session ON bills(session_id);
CREATE INDEX idx_bills_state ON bills(state);
CREATE INDEX idx_bills_updated ON bills(updated_at);

-- New bill_tenants with string bill_id
CREATE TABLE bill_tenants (
  bill_id             TEXT NOT NULL REFERENCES bills(bill_id),
  tenant_id           TEXT NOT NULL,
  matched_keyword     TEXT,
  notified_at         TEXT,
  PRIMARY KEY (bill_id, tenant_id)
);

-- Add ingestion_mode to tenants (preserves existing data)
ALTER TABLE tenants ADD COLUMN ingestion_mode TEXT NOT NULL DEFAULT 'all';

-- Rate limit tracking
CREATE TABLE api_call_log (
  date                TEXT NOT NULL,
  provider            TEXT NOT NULL,
  call_count          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, provider)
);
