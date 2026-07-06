-- Many-to-many: a custom calendar event can link to multiple bills.
-- Hearing events keep using calendar_events.bill_id (1:1, sourced from central).
CREATE TABLE calendar_event_bills (
  event_id TEXT NOT NULL REFERENCES calendar_events(id),
  bill_id  TEXT NOT NULL,
  PRIMARY KEY (event_id, bill_id)
);
CREATE INDEX idx_calendar_event_bills_bill ON calendar_event_bills(bill_id);

-- Backfill existing single-linked custom events into the join table.
INSERT INTO calendar_event_bills (event_id, bill_id)
SELECT id, bill_id FROM calendar_events
WHERE source = 'custom' AND bill_id IS NOT NULL;
