import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
import { bills, calendarEvents, customFieldDefinitions } from '../db/schema'
import { groupHasPriority, holdsGroupValue, type BillsTable } from './teamFields'

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
 * qualifies for display: its bill has a priority, or a bill it is grouped
 * with has (a companion group has one priority, so a hearing on a member
 * shows whichever member the priority was set on), and no body event the
 * instance shows covers it. The one definition the calendar, ICS feed,
 * dashboard count, and week-ahead email share, so they can't drift apart.
 * Needs `bills` left-joined on calendar_events.bill_id.
 */
export const prioritizedBillEntry = and(
  eq(calendarEvents.source, 'hearing'),
  groupHasPriority(bills),
  or(
    isNull(calendarEvents.coveredBy),
    // A cover whose event the instance doesn't have, or hides, shows the entry after all.
    sql`NOT EXISTS (SELECT 1 FROM calendar_events AS cover WHERE cover.uid = calendar_events.covered_by AND cover.source = 'body' AND cover.rule_match IS NOT 0)`,
  ),
)!

/**
 * A date custom field's value that becomes a team calendar event: a `date`
 * field (every one, with no per-field opt-in) whose value is its group's
 * current one (`holdsGroupValue`: a bill in no group is its own group) on a
 * group with a priority on any member (`groupHasPriority`), the same rule a
 * bill's own entries follow. A value a newer one replaced, on another member,
 * projects nothing, so a group has at most one event per field. The one
 * definition the calendar, the ICS feed, the dashboard count, and the
 * week-ahead email share (lib/dateFieldEvents.ts). Needs the value's rows as
 * `p`, their bill as `me` (`holdsGroupValue`'s aliases), and
 * custom_field_definitions joined on the value's field.
 */
export function prioritizedDateFieldValue(me: BillsTable): SQL {
  return and(
    eq(customFieldDefinitions.type, 'date'),
    holdsGroupValue('bill_custom_field_values'),
    groupHasPriority(me),
  )!
}

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
