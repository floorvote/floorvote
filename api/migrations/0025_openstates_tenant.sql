-- OpenStates tenant migration: clean break on all bill data.
-- Preserves: users, sessions (auth), magic_links, roles, user_roles,
--            association_config, custom_field_definitions.

-- Drop in FK dependency order
DROP TABLE IF EXISTS comment_mentions;
DROP TABLE IF EXISTS comment_reactions;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS feed_events;
DROP TABLE IF EXISTS member_votes;
DROP TABLE IF EXISTS official_positions;
DROP TABLE IF EXISTS public_reports;
DROP TABLE IF EXISTS bill_custom_field_values;
DROP TABLE IF EXISTS bill_texts;
DROP TABLE IF EXISTS bill_calendar;
DROP TABLE IF EXISTS bill_amendments;
DROP TABLE IF EXISTS bill_supplements;
DROP TABLE IF EXISTS bills;

-- Recreate bills with OpenStates-compatible schema
CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  bill_number TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  session TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  abstract TEXT,
  url TEXT,
  state_url TEXT,
  provider_updated_at TEXT,
  text_r2_key TEXT,
  tenant_summary TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
  sponsor TEXT,
  sponsor_party TEXT,
  sponsor_url TEXT,
  co_sponsors TEXT,
  last_action TEXT,
  last_action_date TEXT,
  history TEXT,
  related_bill_ids TEXT,
  companion_bill_ids TEXT,
  state_link TEXT,
  committee TEXT,
  source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'manual')),
  added_by TEXT,
  relevance_score INTEGER,
  central_synced_at TEXT,
  ai_processed_at TEXT,
  last_ai_text_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recreate bill_texts with string doc_id (was INTEGER)
CREATE TABLE bill_texts (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'text/html',
  text_hash TEXT NOT NULL DEFAULT '',
  r2_key TEXT,
  state_link TEXT,
  alt_state_link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recreate engagement tables empty
CREATE TABLE feed_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('bill_added','priority_set','position_set','comment_added','vote_milestone','bill_updated')),
  bill_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  suppressed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE comment_reactions (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE comment_mentions (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('user', 'role')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE member_votes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  position TEXT NOT NULL CHECK (position IN ('support', 'oppose', 'neutral')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE official_positions (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL UNIQUE,
  position TEXT NOT NULL,
  notes TEXT,
  set_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE public_reports (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  bill_ids TEXT NOT NULL DEFAULT '[]',
  generated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE bill_custom_field_values (
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  set_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bill_id, field_id)
);
