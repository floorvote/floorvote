-- Re-namespace iCal event UIDs from @example.org to @example.com after the
-- domain cutover. The UID is the stable re-import dedup key for imported
-- hearings (importUid in api/src/lib/calendarImport.ts) and the stored
-- identifier emitted in the ICS feed; swapping the suffix in place keeps dedup
-- matching the new @example.com formula so re-imports don't duplicate events.
-- Idempotent: a second run matches nothing.
UPDATE calendar_events
SET uid = replace(uid, '@example.org', '@example.com')
WHERE uid LIKE '%@example.org';
