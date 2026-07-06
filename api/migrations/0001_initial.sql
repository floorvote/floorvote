-- api/migrations/0001_initial.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'owner')),
  invited_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_active TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE magic_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  bill_number TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  session TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  text_r2_key TEXT,
  llm_summary TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  is_priority INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'manual')),
  added_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE member_votes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  position TEXT NOT NULL CHECK (position IN ('support', 'oppose', 'neutral')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, bill_id)
);

CREATE TABLE official_positions (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  notes TEXT,
  set_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (bill_id)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE comment_reactions (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (comment_id, user_id, emoji)
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (bill_id, user_id)
);

CREATE TABLE feed_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'bill_added', 'priority_set', 'position_set', 'comment_added', 'vote_milestone'
  )),
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE public_reports (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  bill_ids TEXT NOT NULL DEFAULT '[]',
  generated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE association_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes
CREATE INDEX idx_sessions_user_id     ON sessions(user_id);
CREATE INDEX idx_magic_links_user_id  ON magic_links(user_id);
CREATE INDEX idx_bills_is_priority    ON bills(is_priority);
CREATE UNIQUE INDEX idx_bills_external_id ON bills(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_feed_events_bill_id  ON feed_events(bill_id);
CREATE INDEX idx_feed_events_created  ON feed_events(created_at DESC);
CREATE INDEX idx_comments_bill_id     ON comments(bill_id);
CREATE INDEX idx_member_votes_bill_id ON member_votes(bill_id);

-- Seed default config values
INSERT INTO association_config (key, value) VALUES
  ('association_name', '"My Association"'),
  ('position_vocabulary', '["Support","Oppose","Amend","Monitor","No Position"]'),
  ('reaction_emojis', '["👍","👎","❤️","😮"]'),
  ('allowed_domains', '[]');
