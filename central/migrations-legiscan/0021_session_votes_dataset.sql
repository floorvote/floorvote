-- Track the weekly per-member vote load for each session.
--
-- LegiScan's getBill carries only roll call totals. Each legislator's vote comes
-- from getRollCall (one quota call per roll call) or from the weekly bulk
-- dataset, which holds every getRollCall record for a session. Central reads the
-- dataset: it checks each covered session's dataset hash about once a week and
-- downloads the archive only when the hash changed.
--
-- votes_dataset_hash is the dataset hash whose votes were fully loaded, and is
-- null until the first load finishes. votes_checked_at is when the hash was last
-- compared, so the daily tick can tell which sessions are due.
ALTER TABLE sessions ADD COLUMN votes_dataset_hash TEXT;
ALTER TABLE sessions ADD COLUMN votes_checked_at TEXT;
