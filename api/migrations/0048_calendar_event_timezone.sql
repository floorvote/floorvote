-- Creator's browser IANA timezone, captured when a custom event is added.
-- Used by the ICS feed as the fallback zone when an event's state cannot be
-- resolved (multi-state instance plus a custom event with no linked bill), so the
-- subscription shows the event in the zone of whoever created it rather than a
-- fixed tenant default. Nullable. Hearings and pre-existing events leave it NULL.
ALTER TABLE calendar_events ADD COLUMN timezone TEXT;
