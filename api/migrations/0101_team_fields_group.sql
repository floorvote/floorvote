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
-- One pass over the priority events, each bulk event's bill list unpacked
-- once, rather than a lookup per bill that would scan every bulk event again.
-- On 52,000 bills and 225,000 feed events that is the difference between
-- hundredths of a second and several seconds.
--
-- No semicolons in these comments. api/test/helpers.ts splits migration files
-- on the statement terminator before it strips comment lines.
ALTER TABLE bills ADD COLUMN priority_set_at TEXT;

UPDATE bills SET priority_set_at = latest.set_at
FROM (
  SELECT bill_id, MAX(created_at) AS set_at FROM (
    SELECT fe.bill_id AS bill_id, fe.created_at AS created_at FROM feed_events fe
    WHERE fe.type = 'priority_set' AND fe.bill_id IS NOT NULL
    UNION ALL
    SELECT j.value AS bill_id, fe.created_at AS created_at FROM feed_events fe, json_each(fe.metadata, '$.billIds') j
    WHERE fe.type = 'priority_set' AND fe.bill_id IS NULL
  )
  GROUP BY bill_id
) AS latest
WHERE latest.bill_id = bills.id AND bills.priority IS NOT NULL;
