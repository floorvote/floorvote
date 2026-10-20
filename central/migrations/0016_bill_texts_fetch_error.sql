-- Record why a bill-text download failed.
--
-- Before this, a failed fetch and a fetch that had never run were both just
-- "r2_key IS NULL", so there was no way to see that a state had stopped serving
-- us documents. Indiana's site answers non-browser clients with its JavaScript
-- app shell (HTTP 200, text/html, ~691 bytes) for URLs ending in .pdf. We stored
-- that as the document, and every one of those bills then failed AI with
-- "The document has no pages" while looking, in the database, exactly like a
-- bill that had simply not been processed yet.
--
-- fetch_error holds a short human-readable reason, and is null on success.
-- fetch_attempted_at records when the attempt ran, so a stale failure can be
-- told apart from a fresh one.
ALTER TABLE bill_texts ADD COLUMN fetch_error TEXT;
ALTER TABLE bill_texts ADD COLUMN fetch_attempted_at TEXT;
