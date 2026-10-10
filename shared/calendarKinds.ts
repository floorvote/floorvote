/**
 * What a calendar entry is. Central sets one on every entry it sends, from the
 * provider's vocabulary (each calendar event type names its kind), so
 * instances never work it out from an entry's identity or type id.
 *
 * - `hearing`: a committee hearing or roundtable, where the public can
 *   usually testify.
 * - `markup`: a committee meeting that acts on the bill (amends it, votes on
 *   it), such as a mark-up or an executive session.
 * - `meeting`: any other meeting of the legislature or one of its bodies.
 * - `deadline`: a date set in law for the bill's next step, such as the end
 *   of an executive's time to sign or veto. Not a meeting.
 */
export const CALENDAR_KINDS = ['hearing', 'markup', 'meeting', 'deadline'] as const

export type CalendarKind = typeof CALENDAR_KINDS[number]

export function isCalendarKind(value: unknown): value is CalendarKind {
  return typeof value === 'string' && (CALENDAR_KINDS as readonly string[]).includes(value)
}
