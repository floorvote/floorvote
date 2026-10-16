-- Where a bill's keyword match came from, as central declares it (#364):
-- 'routine' when the regular sync found a bill new to central for this
-- instance, 'bulk' for a session seed, a keyword re-run, or an operator import.
-- Only routine matches reach the digest's new-match section (and the feed).
--
-- Existing rows get NULL, which counts as bulk, so matches made before this
-- upgrade stay out of feeds and digests. Written once, with the match.
ALTER TABLE bills ADD COLUMN match_provenance TEXT;
