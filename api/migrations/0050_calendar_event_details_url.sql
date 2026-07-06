-- 0050_calendar_event_details_url.sql
-- Free-form notes body (ICS DESCRIPTION) and optional user link for custom events.
ALTER TABLE calendar_events ADD COLUMN details TEXT;
ALTER TABLE calendar_events ADD COLUMN url TEXT;
