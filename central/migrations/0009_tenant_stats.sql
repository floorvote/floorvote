CREATE TABLE tenant_stats (
  tenant_id              TEXT NOT NULL,
  stat_date              TEXT NOT NULL,
  total_members          INTEGER NOT NULL DEFAULT 0,
  active_members_7d      INTEGER NOT NULL DEFAULT 0,
  active_members_30d     INTEGER NOT NULL DEFAULT 0,
  votes_cast             INTEGER NOT NULL DEFAULT 0,
  comments_written       INTEGER NOT NULL DEFAULT 0,
  comment_reactions      INTEGER NOT NULL DEFAULT 0,
  positions_set          INTEGER NOT NULL DEFAULT 0,
  notes_created          INTEGER NOT NULL DEFAULT 0,
  custom_field_values    INTEGER NOT NULL DEFAULT 0,
  bills_with_engagement  INTEGER NOT NULL DEFAULT 0,
  roles_defined          INTEGER NOT NULL DEFAULT 0,
  custom_fields_defined  INTEGER NOT NULL DEFAULT 0,
  bills_ai_processed     INTEGER NOT NULL DEFAULT 0,
  pulled_at              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, stat_date)
);
CREATE INDEX idx_tenant_stats_date ON tenant_stats(stat_date);
