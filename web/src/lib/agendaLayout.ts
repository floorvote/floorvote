import type { CalendarEvent } from './calendarGrid'

/**
 * Height of a trailing spacer that lets today's group scroll to just below the
 * sticky header, with no dead space when content already fills the viewport.
 *
 *   spacer = max(0, viewportHeight − headerHeight − heightBelowTodaysTop)
 */
export function computeSpacerHeight(
  viewportHeight: number,
  headerHeight: number,
  heightBelowTodaysTop: number,
): number {
  return Math.max(0, viewportHeight - headerHeight - heightBelowTodaysTop)
}

/** End-of-list marker text for the agenda. */
export function agendaFooterLabel(
  events: CalendarEvent[],
  today: string,
): 'End of agenda' | 'No upcoming events' {
  const hasUpcoming = events.some(e => e.date != null && e.date >= today)
  return hasUpcoming ? 'End of agenda' : 'No upcoming events'
}
