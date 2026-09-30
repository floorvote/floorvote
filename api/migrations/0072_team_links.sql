-- Team documents: links (usually Google Drive) that admins attach to a bill or
-- a calendar event, such as comment letters, testimony, and redlines. FloorVote
-- stores only the title and URL. The document stays where it lives, under its
-- own sharing settings. The deep-analysis worker reads linked documents when it
-- writes that subject's analysis or brief.
CREATE TABLE team_links (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('bill', 'event')),
  subject_id   TEXT NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  added_by     TEXT,
  added_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_team_links_subject ON team_links (subject_kind, subject_id);
