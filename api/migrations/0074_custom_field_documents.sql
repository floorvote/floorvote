-- Allow a 'document' custom field type: a list of titled https links, such as
-- the team's testimony, comment letters, or redlines for a bill.
--
-- SQLite cannot ALTER a CHECK constraint, so custom_field_definitions is rebuilt,
-- as 0041 and 0053 rebuilt their tables. Here that needs one more step.
-- bill_custom_field_values references custom_field_definitions ON DELETE CASCADE,
-- and D1 enforces foreign keys, so DROP TABLE custom_field_definitions would first
-- delete every stored value through that cascade. PRAGMA foreign_keys = OFF does
-- not help: it is a no-op inside the transaction a migration runs in. So the values
-- are set aside, both tables are rebuilt, and the values are copied back.
--
-- bill_custom_field_values is recreated exactly as 0025 left it.

CREATE TABLE bill_custom_field_values_keep AS SELECT * FROM bill_custom_field_values;

DROP TABLE bill_custom_field_values;

CREATE TABLE custom_field_definitions_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('binary', 'dropdown', 'text', 'date', 'document')),
  options TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  slug TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  multiple INTEGER NOT NULL DEFAULT 0
);

INSERT INTO custom_field_definitions_new (id, name, type, options, display_order, created_at, updated_at, slug, pinned, multiple)
SELECT id, name, type, options, display_order, created_at, updated_at, slug, pinned, multiple FROM custom_field_definitions;

DROP TABLE custom_field_definitions;

ALTER TABLE custom_field_definitions_new RENAME TO custom_field_definitions;

CREATE UNIQUE INDEX idx_custom_field_definitions_slug ON custom_field_definitions(slug);

CREATE TABLE bill_custom_field_values (
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  set_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bill_id, field_id)
);

INSERT INTO bill_custom_field_values (bill_id, field_id, value, set_by, updated_at)
SELECT bill_id, field_id, value, set_by, updated_at FROM bill_custom_field_values_keep;

DROP TABLE bill_custom_field_values_keep;
