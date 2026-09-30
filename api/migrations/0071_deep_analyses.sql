-- Deep analyses: longer, stronger-model write-ups of high-stakes bills and
-- briefs for upcoming hearings, produced by an external worker.
--
-- FloorVote does not call a model for these. It keeps a queue here, one row
-- per subject (a bill, or a calendar event for a hearing brief). A worker the
-- operator runs claims a pending row, fetches its input bundle, and posts the
-- result back (routes/deepApi.ts). The worker can be anything that follows the
-- served instructions: a scheduled Claude or Codex task on a subscription, or
-- an API-backed job.
--
-- input_hash identifies what the request asks about (the bill text hash, the
-- event and its linked bills, the prompt version). A changed input puts the
-- row back to pending and keeps the previous content visible, marked as based
-- on older input via content_input_hash, until the new result arrives.
-- attempts counts claims of the current input, so a request that keeps failing
-- stops being offered after a few tries.
CREATE TABLE deep_analyses (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('bill', 'hearing')),
  subject_id         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'error')),
  input_hash         TEXT NOT NULL,
  requested_by       TEXT,
  requested_at       TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at         TEXT,
  claimed_by         TEXT,
  content            TEXT,
  content_input_hash TEXT,
  model              TEXT,
  completed_at       TEXT,
  error              TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, subject_id)
);

CREATE INDEX idx_deep_analyses_status ON deep_analyses (status, requested_at);
