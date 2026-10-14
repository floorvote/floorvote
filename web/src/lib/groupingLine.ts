import type { GroupingEvent } from '../../../shared/companionGroups'
import { formatLongMonthDay } from './calendarDate'
import { dbTsToEpoch } from '../../../shared/time'

/**
 * The line a bill's comment thread shows where its companion group formed or
 * split, so the comments around it make sense: after a grouping the thread
 * interleaves the companions' comments, and after a split it stops.
 */
export function groupingLineText(event: GroupingEvent): string {
  const bills = listBillNumbers(event.with.map(b => b.billNumber))
  const date = formatLongMonthDay(event.createdAt)
  const one = event.with.length === 1
  if (event.type === 'grouped') {
    const together = `Earlier comments from ${one ? 'both' : 'all of them'} now appear together.`
    return event.actorName
      ? `${event.actorName} grouped this bill with ${bills} on ${date}. ${together}`
      : `Grouped with ${bills} as identical bills on ${date}. ${together}`
  }
  const apart = `Comments posted on ${one ? bills : 'them'} no longer appear here.`
  return event.actorName
    ? `${event.actorName} separated this bill from ${bills} on ${date}. ${apart}`
    : `Separated from ${bills} on ${date}. ${apart}`
}

/**
 * Where each grouping line goes in a comment thread ordered by time: before
 * the first comment posted after it, or after them all.
 */
export function placeGroupingLines(
  comments: readonly { id: string; createdAt: string }[],
  events: readonly GroupingEvent[],
): { before: Map<string, GroupingEvent[]>; after: GroupingEvent[] } {
  const before = new Map<string, GroupingEvent[]>()
  const after: GroupingEvent[] = []
  for (const event of events) {
    const at = dbTsToEpoch(event.createdAt)
    const next = comments.find(c => dbTsToEpoch(c.createdAt) > at)
    if (next) before.set(next.id, [...(before.get(next.id) ?? []), event])
    else after.push(event)
  }
  return { before, after }
}

// "A1", "A1 and A2", "A1, A2, and A3"
function listBillNumbers(numbers: readonly string[]): string {
  if (numbers.length <= 2) return numbers.join(' and ')
  return `${numbers.slice(0, -1).join(', ')}, and ${numbers[numbers.length - 1]}`
}
