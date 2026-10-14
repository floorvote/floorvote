import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { bills, calendarEvents } from '../db/schema'

/**
 * Which calendar rows the calendar page, the ICS feed, and the dashboard's
 * upcoming count show, for queries that left-join `bills` on
 * calendar_events.bill_id:
 * - a bill's own entries ('hearing', deadlines included) for bills with a
 *   priority, so a large keyword match doesn't flood the calendar, unless a
 *   body event the instance shows covers the entry (covered_by): the event is
 *   shown in its place, so the hearing appears once (lib/bodyEvents.ts). An
 *   entry whose cover the instance's event rules hide shows after all, and a
 *   deadline is never covered;
 * - custom events;
 * - body events, the legislature's own calendar for covered states, unless the
 *   instance's event rules hide them (rule_match 0, lib/eventRules.ts), and a
 *   fork's 'council' rows (#217) not yet taken over as body events, so its
 *   calendar history stays.
 */
/**
 * A bill's own entry ('hearing' source: hearings, markups, deadlines) that
 * qualifies for display: its bill has a priority, and no body event the
 * instance shows covers it. The one definition the calendar, ICS feed,
 * dashboard count, and week-ahead email share, so they can't drift apart.
 * Needs `bills` left-joined on calendar_events.bill_id.
 */
export const prioritizedBillEntry = and(
  eq(calendarEvents.source, 'hearing'),
  isNotNull(bills.priority),
  or(
    isNull(calendarEvents.coveredBy),
    // A cover whose event the instance doesn't have, or hides, shows the entry after all.
    sql`NOT EXISTS (SELECT 1 FROM calendar_events AS cover WHERE cover.uid = calendar_events.covered_by AND cover.source = 'body' AND cover.rule_match IS NOT 0)`,
  ),
)!

export const visibleCalendarEvent = or(
  prioritizedBillEntry,
  eq(calendarEvents.source, 'custom'),
  and(eq(calendarEvents.source, 'body'), sql`${calendarEvents.ruleMatch} IS NOT 0`),
  eq(calendarEvents.source, 'council'),
)!

/**
 * Bill entries describing the same real meeting (same date, time, description,
 * and location) are one entry carrying every bill. A deadline never merges
 * into a meeting. Other kinds aren't told apart: an entry central hasn't resent
 * since kinds arrived has none, and must still merge with the same meeting on
 * another bill.
 */
export function billEntryGroupKey(e: { kind: string | null; date: string | null; time: string | null; description: string | null; location: string | null }): string {
  return `${e.kind === 'deadline' ? 'deadline' : 'event'}|${e.date}|${e.time ?? ''}|${(e.description ?? '').trim()}|${(e.location ?? '').trim()}`
}
