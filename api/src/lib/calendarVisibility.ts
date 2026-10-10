import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { bills, calendarEvents } from '../db/schema'

/**
 * Which calendar rows the calendar page, the ICS feed, and the dashboard's
 * upcoming count show, for queries that left-join `bills` on
 * calendar_events.bill_id:
 * - a bill's own entries ('hearing') for bills with a priority, so a large
 *   keyword match doesn't flood the calendar, unless a body event the instance
 *   has covers the entry (covered_by): the event is shown in its place, so
 *   the hearing appears once (lib/bodyEvents.ts);
 * - custom events;
 * - body events, the legislature's own calendar for covered states.
 */
export const visibleCalendarEvent = or(
  and(
    eq(calendarEvents.source, 'hearing'),
    isNotNull(bills.priority),
    or(
      isNull(calendarEvents.coveredBy),
      // A cover whose event the instance doesn't have shows the entry after all.
      sql`NOT EXISTS (SELECT 1 FROM calendar_events AS cover WHERE cover.uid = calendar_events.covered_by AND cover.source = 'body')`,
    ),
  ),
  eq(calendarEvents.source, 'custom'),
  eq(calendarEvents.source, 'body'),
)!
