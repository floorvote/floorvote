-- Team fields shared across a companion group (#377). A group reads each team
-- field (position, priority, custom field values, tags, triage, and the team
-- summary) from the member where it was set most recently. Every other field
-- already records when it was set. bills.priority_set_at does that for the
-- priority, which until now had no time of its own.
--
-- An existing priority takes the time of its latest priority feed event,
-- written on the bill itself or by a bulk edit that listed the bill in
-- metadata.billIds. A priority with no such event keeps a NULL time, which
-- reads as the oldest.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE bills ADD COLUMN priority_set_at TEXT;

UPDATE bills SET priority_set_at = (
  SELECT MAX(fe.created_at) FROM feed_events fe
  WHERE fe.type = 'priority_set'
    AND (fe.bill_id = bills.id
      OR (fe.bill_id IS NULL AND EXISTS (SELECT 1 FROM json_each(fe.metadata, '$.billIds') j WHERE j.value = bills.id)))
)
WHERE priority IS NOT NULL;
