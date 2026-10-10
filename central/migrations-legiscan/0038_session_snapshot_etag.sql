-- The ETag of the snapshot file a provider last read in full for a session
-- (#300). The Maryland General Assembly regenerates its session file through
-- the day, and a conditional request with this ETag answers 304 Not Modified
-- for a file that hasn't changed, so the sync skips about 8 MB.
--
-- Opaque to core, which stores what the provider returns once a pass
-- completes, hands it back on the next scheduled pass, and clears a state's
-- when the state is claimed. A nullable column only. Existing rows keep null,
-- which means read the file in full. LegiScan never sets it.
ALTER TABLE sessions ADD COLUMN snapshot_etag TEXT;
