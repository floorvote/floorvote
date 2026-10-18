-- Claim sources from the bill analysis (#568). The model returns, for each
-- claim in the summary, a short quote from the bill text that supports it (and
-- on a PDF, the page it is on).
--
-- claim_sources is a JSON array of objects, {claim, quote} for HTML and
-- {claim, quote, page} for PDF. Objects rather than columns, so a later step
-- can add fields to each item (how the quote resolved, and where) with no
-- schema change, and count them with json_each.
--
-- claim_sources_doc_id and claim_sources_text_hash pin the list to the
-- document the model read, which is the one central's text endpoint served.
-- That is not always last_ai_text_doc_id, which is the newest document by date.
--
-- Null in all three means the bill has no claim sources. Every bill starts
-- that way and keeps it until its next analysis, and an analysis that did not
-- ask for them writes null, so a re-analysis always replaces the list.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE bills ADD COLUMN claim_sources TEXT;
ALTER TABLE bills ADD COLUMN claim_sources_doc_id TEXT;
ALTER TABLE bills ADD COLUMN claim_sources_text_hash TEXT;
