-- A recording of the meeting a history entry happened at (#294): DC LIMS
-- publishes videos of hearings, mark-ups, and floor readings, and the bill
-- page links each from its entry in the legislative history.
--
-- A nullable column only. Existing rows keep null, and the ingest fills it the
-- next time it replaces a bill's history. LegiScan never sets it.
ALTER TABLE bill_history ADD COLUMN video_url TEXT;
