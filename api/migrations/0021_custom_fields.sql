-- api/migrations/0021_custom_fields.sql

CREATE TABLE custom_field_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('binary', 'dropdown', 'text', 'date')),
  options TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bill_custom_field_values (
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  set_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bill_id, field_id)
);

CREATE INDEX idx_bill_cf_values_field_value ON bill_custom_field_values(field_id, value);
