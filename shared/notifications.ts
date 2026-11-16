/** The day the week ahead email goes out when an instance never chose one: Friday (0 is Sunday, 6 is Saturday, UTC). */
export const DEFAULT_WEEK_AHEAD_DAY = 5

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** When a person's email digest is sent, as a phrase for a sentence: "every morning", or "every Friday morning" for one weekly on a weekday (0 Sunday to 6 Saturday). */
export function digestSentPhrase(weeklyDay: number | null | undefined): string {
  if (weeklyDay == null || !WEEKDAYS[weeklyDay]) return 'every morning'
  return `every ${WEEKDAYS[weeklyDay]} morning`
}

/** When the week ahead email is sent, as a phrase for a sentence: "every Friday morning". A day outside 0 to 6 reads as Friday. */
export function weekAheadSentPhrase(day: number): string {
  return `every ${WEEKDAYS[day] ?? WEEKDAYS[DEFAULT_WEEK_AHEAD_DAY]} morning`
}
