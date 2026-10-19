import type { GroupingEvent } from '../../../shared/companionGroups'
import type { FieldChangeEvent } from '../../../shared/teamFields'
import { formatLongMonthDay } from './calendarDate'
import { dbTsToEpoch } from '../../../shared/time'

/**
 * The line a bill's comment thread shows where its companion group formed or
 * split, so the comments around it make sense: after a grouping the thread
 * interleaves the companions' comments, and after a split it stops. The
 * comments sentence names the bills in `commentBills` and is left out when
 * none had a comment before the event.
 */
export function groupingLineText(event: GroupingEvent): string {
  const bills = listBillNumbers(event.with.map(b => b.billNumber))
  const date = formatLongMonthDay(event.createdAt)
  const commentBills = listBillNumbers((event.commentBills ?? []).map(b => b.billNumber))
  const hasComments = (event.commentBills ?? []).length > 0
  if (event.type === 'grouped') {
    const comments = hasComments ? ` Earlier comments on ${commentBills} now appear here.` : ''
    // The team field values the grouping replaced, so an admin can put back
    // one that shouldn't have lost.
    const replaced = (event.replaced ?? []).map(r =>
      ` ${r.billNumber}'s ${r.label}, ${r.value}, was replaced by ${r.replacedBy.billNumber}'s, ${r.replacedBy.value}.`).join('')
    // The splits grouping by hand undid, so the thread keeps what the admin was told.
    const undone = event.undoneSplits ?? []
    const undid = undone.length === 0 ? '' : ` It undid the split${undone.length === 1 ? '' : 's'} of ${listClauses(undone.map(([a, b]) => `${a.billNumber} and ${b.billNumber}`))}.`
    return event.actorName
      ? `${event.actorName} grouped this bill with ${bills} on ${date}.${comments}${undid}${replaced}`
      : `Grouped with ${bills} as identical bills on ${date}.${comments}${undid}${replaced}`
  }
  const apart = hasComments ? ` Comments posted on ${commentBills} no longer appear here.` : ''
  return event.actorName
    ? `${event.actorName} separated this bill from ${bills} on ${date}.${apart}`
    : `Separated from ${bills} on ${date}.${apart}`
}

/**
 * Whether the event's line appears in the thread. An admin's grouping or
 * split always does, and so does a grouping that replaced a team value or
 * undid a split. One FloorVote made on its own appears only when it explains
 * a change to the thread: a comment was posted, before it, on a bill it
 * joined or left. Otherwise it would describe comments that aren't there.
 */
export function showsGroupingLine(event: GroupingEvent): boolean {
  return !!event.actorName
    || (event.commentBills ?? []).length > 0
    || (event.replaced ?? []).length > 0
    || (event.undoneSplits ?? []).length > 0
}

/**
 * Where each grouping line that shows goes in a comment thread ordered by time:
 * before the first comment posted after it, or after them all.
 */
export function placeGroupingLines(
  comments: readonly { id: string; createdAt: string }[],
  events: readonly GroupingEvent[],
): { before: Map<string, GroupingEvent[]>; after: GroupingEvent[] } {
  const before = new Map<string, GroupingEvent[]>()
  const after: GroupingEvent[] = []
  for (const event of events.filter(showsGroupingLine)) {
    const at = dbTsToEpoch(event.createdAt)
    const next = comments.find(c => dbTsToEpoch(c.createdAt) > at)
    if (next) before.set(next.id, [...(before.get(next.id) ?? []), event])
    else after.push(event)
  }
  return { before, after }
}

/** A line of a comment thread's activity: a grouping line or a team field change. */
export type ThreadLine =
  | { kind: 'grouping'; key: string; event: GroupingEvent }
  | { kind: 'change'; key: string; event: FieldChangeEvent }

/**
 * Where each line of a bill's activity goes in a comment thread ordered by time,
 * as `placeGroupingLines` places a grouping line: before the first comment posted
 * after it, or after them all (a comment at the very second of one sits above
 * it). Grouping lines and team field changes share one time order, a grouping
 * line first on a tie. Every change is its own line, however many one person
 * makes in a row.
 */
export function placeThreadLines(
  comments: readonly { id: string; createdAt: string }[],
  groupingEvents: readonly GroupingEvent[],
  fieldEvents: readonly FieldChangeEvent[],
): { before: Map<string, ThreadLine[]>; after: ThreadLine[] } {
  const grouping = placeGroupingLines(comments, groupingEvents)
  const gaps = new Map<string | null, Array<{ at: number; line: ThreadLine }>>()
  const add = (gap: string | null, at: number, line: ThreadLine) => gaps.set(gap, [...(gaps.get(gap) ?? []), { at, line }])
  for (const [gap, events] of grouping.before) for (const event of events) add(gap, dbTsToEpoch(event.createdAt), { kind: 'grouping', key: event.id, event })
  for (const event of grouping.after) add(null, dbTsToEpoch(event.createdAt), { kind: 'grouping', key: event.id, event })
  for (const event of fieldEvents) {
    const at = dbTsToEpoch(event.createdAt)
    add(comments.find(c => dbTsToEpoch(c.createdAt) > at)?.id ?? null, at, { kind: 'change', key: event.id, event })
  }
  const inOrder = (gap: string | null) => (gaps.get(gap) ?? []).sort((a, b) => a.at - b.at).map(item => item.line)
  const before = new Map<string, ThreadLine[]>()
  for (const gap of gaps.keys()) if (gap !== null) before.set(gap, inOrder(gap))
  return { before, after: inOrder(null) }
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
