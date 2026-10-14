/**
 * Where a calendar event comes from. One named union the API and the web app
 * share, so a marker, label, or edit rule can't drift into a string comparison
 * of its own.
 *
 * - `hearing`: a bill's own calendar entry, from central (its kind says whether
 *   it's a hearing, markup, meeting, or deadline).
 * - `custom`: an event the instance's admins made.
 * - `body`: an event on a legislature's own calendar, from central.
 * - `council`: a fork's calendar rows from before body events.
 * - `field`: a date custom field's value on a prioritized bill, projected onto
 *   the calendar at read time. Never stored, and never has a kind.
 */
export const EVENT_SOURCES = ['hearing', 'custom', 'body', 'council', 'field'] as const

export type EventSource = (typeof EVENT_SOURCES)[number]

/** Whether an admin can edit, cancel, or delete the event from the calendar. Only the instance's own custom events: every other source is owned somewhere else (central, or the bill page). */
export function canEditEventSource(source: EventSource): boolean {
  return source === 'custom'
}

/** Where a date-field event's date is set, as the popover and the feed's description say it. The bill page is the only place the date can change. */
export function dateFieldNote(fieldName: string, billNumber: string): string {
  return `Set from the ${fieldName} field on ${billNumber}`
}
