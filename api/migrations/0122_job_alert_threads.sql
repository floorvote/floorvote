-- One row a job: the email conversation that job's failure alerts share
-- (api/src/lib/alertThread.ts). A conversation lasts one outage. It ends when
-- the job's next run that does its work sends a resolved email, or a run finds
-- the job switched off. Times are UTC, written as datetime('now') writes them.
CREATE TABLE job_alert_threads (
  job TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  last_alerted_at TEXT NOT NULL
);
