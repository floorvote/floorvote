-- 0002_api_call_log_v2.sql
-- Replace the rollup api_call_log (date + call_count) with an append-only
-- detail log capturing call_type and params per call. See
-- docs/superpowers/specs/2026-05-21-legiscan-sync-observability-design.md

DROP TABLE IF EXISTS api_call_log;

CREATE TABLE api_call_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at  TEXT NOT NULL DEFAULT (datetime('now')),
  call_type  TEXT NOT NULL,
  params     TEXT NOT NULL
);
