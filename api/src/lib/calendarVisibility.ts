import { and, eq, isNotNull, or } from 'drizzle-orm'
import { bills, calendarEvents } from '../db/schema'

/**
 * Which calendar rows a team sees, for queries that left-join `bills` on
 * calendar_events.bill_id:
 * - bill hearings ('hearing') only for bills with a priority, so a large
 *   keyword match does not flood the calendar;
 * - DC deadlines ('deadline': Mayor's response due, Congressional review ends,
 *   expirations) for every tracked bill, since a missed deadline costs more than
 *   a crowded day and they are few;
 * - custom and DC Council calendar events always.
 */
export const visibleCalendarSource = or(
  and(eq(calendarEvents.source, 'hearing'), isNotNull(bills.priority)),
  and(eq(calendarEvents.source, 'deadline'), or(isNotNull(bills.matchType), isNotNull(bills.priority))),
  eq(calendarEvents.source, 'custom'),
  eq(calendarEvents.source, 'council'),
)
