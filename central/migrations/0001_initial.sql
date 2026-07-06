CREATE TABLE legi_sessions (
  session_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  year_start INTEGER NOT NULL,
  year_end INTEGER NOT NULL,
  session_name TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  sine_die INTEGER NOT NULL DEFAULT 0,
  dataset_hash TEXT,
  active_sync_frequency_hours INTEGER NOT NULL DEFAULT 24,
  recess_sync_frequency_hours INTEGER NOT NULL DEFAULT 168,
  last_synced_at TEXT
);

CREATE TABLE bills (
  bill_id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status INTEGER,
  status_date TEXT,
  last_action TEXT,
  last_action_date TEXT,
  change_hash TEXT NOT NULL,
  url TEXT,
  full_json TEXT,
  summary TEXT,
  text_r2_key TEXT,
  text_hash TEXT,
  ai_processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bills_state ON bills(state);
CREATE INDEX idx_bills_session ON bills(session_id);
CREATE INDEX idx_bills_change_hash ON bills(bill_id, change_hash);

CREATE TABLE bill_tenants (
  bill_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  matched_keyword TEXT,
  notified_at TEXT,
  PRIMARY KEY (bill_id, tenant_id)
);

CREATE INDEX idx_bill_tenants_tenant ON bill_tenants(tenant_id);

CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT 'Self-hosted',
  state_coverage TEXT NOT NULL,
  ai_billing TEXT NOT NULL DEFAULT 'operator',
  active INTEGER NOT NULL DEFAULT 1,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

CREATE TABLE keyword_registry (
  tenant_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (tenant_id, keyword)
);

CREATE INDEX idx_keyword_registry_keyword ON keyword_registry(keyword);

CREATE TABLE tenant_stats (
  tenant_id TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  bills_tracked INTEGER DEFAULT 0,
  positions_taken INTEGER DEFAULT 0,
  votes_cast INTEGER DEFAULT 0,
  comments_added INTEGER DEFAULT 0,
  active_members INTEGER DEFAULT 0,
  reported_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, stat_date)
);
