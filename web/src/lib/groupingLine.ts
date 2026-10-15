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
    // The team field values the grouping replaced, so an admin can put back
    // one that shouldn't have lost.
    const replaced = (event.replaced ?? []).map(r =>
      ` ${r.billNumber}'s ${r.label}, ${r.value}, was replaced by ${r.replacedBy.billNumber}'s, ${r.replacedBy.value}.`).join('')
    // The splits grouping by hand undid, so the thread keeps what the admin was told.
    const undone = event.undoneSplits ?? []
    const undid = undone.length === 0 ? '' : ` It undid the split${undone.length === 1 ? '' : 's'} of ${listClauses(undone.map(([a, b]) => `${a.billNumber} and ${b.billNumber}`))}.`
    return event.actorName
      ? `${event.actorName} grouped this bill with ${bills} on ${date}. ${together}${undid}${replaced}`
      : `Grouped with ${bills} as identical bills on ${date}. ${together}${undid}${replaced}`
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

// Clauses joined like a list of bills: "X", "X, and Y", "X, Y, and Z".
function listClauses(clauses: readonly string[]): string {
  if (clauses.length <= 2) return clauses.join(', and ')
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`
}
