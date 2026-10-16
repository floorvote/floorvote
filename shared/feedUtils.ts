import { dbTsToEpoch, dbTsToLocalDay } from './time'

export type FeedEvent = {
  id: string
  type: 'bill_added' | 'priority_set' | 'position_set' | 'comment_added' | 'vote_milestone' | 'bill_updated' | 'hearing_added' | 'hearing_changed' | 'hearing_cancelled' | 'bill_matched'
  // Null for an event about no single bill, such as a bulk edit. Then the bill*
  // fields below are empty or null, and `metadata` says what the event is about
  // (a bulk edit lists its bills as metadata.billIds).
  billId: string | null
  billNumber: string
  billSessionSlug: string | null
  billState: string | null
  billTitle: string
  billSummary: string | null
  billPriority: string | null
  billMatchType: 'keyword' | 'manual' | null
  // Optional because several non-feed producers build FeedEvent-shaped objects
  // (api/src/lib/digestEmail.ts, api/src/lib/mentions.ts); absent is read as
  // "not a draft". The card model reads it to label an untitled draft.
  billIsDraft?: boolean
  userId: string
  userName: string
  userTitle: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type GroupedBillEvents = {
  key: string          // `${billId}::${date}`, or `event:${eventId}::${date}` for a bill-less event
  // Null for a bill-less event, which is always a group of exactly that one event.
  billId: string | null
  billNumber: string
  billTitle: string
  billSessionSlug: string | null
  billState: string | null
  billSummary: string | null
  billPriority: string | null
  billMatchType: 'keyword' | 'manual' | null
  billIsDraft?: boolean
  date: string         // YYYY-MM-DD
  events: FeedEvent[]
}

export function groupEventsByBillAndDay(events: FeedEvent[]): GroupedBillEvents[] {
  const map = new Map<string, GroupedBillEvents>()
  for (const e of events) {
    const date = dbTsToLocalDay(e.createdAt)
    // A bill-less event has no bill to share a group with, so it is its own group.
    const key = `${e.billId ?? `event:${e.id}`}::${date}`
    if (!map.has(key)) {
      map.set(key, {
        key, billId: e.billId, billNumber: e.billNumber,
        billTitle: e.billTitle, billSessionSlug: e.billSessionSlug, billState: e.billState,
        billSummary: e.billSummary, billPriority: e.billPriority, billMatchType: e.billMatchType,
        billIsDraft: e.billIsDraft ?? false,
        date, events: [],
      })
    }
    map.get(key)!.events.push(e)
  }
  return Array.from(map.values()).sort((a, b) =>
    dbTsToEpoch(b.events[0].createdAt) - dbTsToEpoch(a.events[0].createdAt)
  )
}

export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>?/g, ' ').replace(/\s+/g, ' ').trim()
}

// Characters of a comment kept in a comment_added event's `preview` metadata.
// The digest email and the Feed both render that stored string verbatim, so the
// cap lives here rather than at the write site alone — billCardModel needs it to
// spot legacy previews that were cut before truncateWithEllipsis existed.
export const COMMENT_PREVIEW_MAX = 120

/** Cut to `max` characters, marking the cut with an ellipsis. */
export function truncateWithEllipsis(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s
}


export type ChangeRecord = {
  changeType: string
  oldValue: string | null
  newValue: string | null
  detail: string | null
}

// Provider-sourced events with no human action behind them. A day-group of a
// non-prioritized bill surfaces on the default feed only if it contains at least
// one NON-passive (engagement) event that day. Exported so the server-side
// nav-dot signal (api feed route's latestEventAt) stays in lockstep with this
// default-feed filter — otherwise the dot lights for events the feed hides.
export const PASSIVE_EVENT_TYPES = new Set<FeedEvent['type']>([
  'bill_updated', 'hearing_added', 'hearing_changed', 'hearing_cancelled', 'bill_matched',
])

export function filterPriorityEvents(groups: GroupedBillEvents[]): GroupedBillEvents[] {
  return groups.filter(group =>
    group.billPriority !== null ||
    group.events.some(e => !PASSIVE_EVENT_TYPES.has(e.type))
  )
}

// A bill-less group has no bill whose analysis could be missing, so it stays.
export function filterFullyAnalyzed(groups: GroupedBillEvents[]): GroupedBillEvents[] {
  return groups.filter(group => group.billId === null || group.billMatchType !== null)
}

export function formatBillUpdateDetail(record: ChangeRecord): string {
  switch (record.changeType) {
    case 'status_change':
      return `Status: ${record.oldValue ?? '?'} → ${record.newValue ?? '?'}`
    case 'action_added':
      return record.newValue ? `Action: ${record.newValue}` : 'New action'
    case 'text_added':
      return record.detail ? `New text: ${record.detail}` : 'New text version'
    case 'amendment_added':
      return record.detail ? `Amendment added: ${record.detail}` : 'Amendment added'
    case 'supplement_added':
      return record.detail ? `Document added: ${record.detail}` : 'Document added'
    case 'sponsor_added':
      return record.newValue ? `Sponsor added: ${record.newValue}` : 'Sponsor added'
    case 'sponsor_removed':
      return record.oldValue ? `Sponsor removed: ${record.oldValue}` : 'Sponsor removed'
    case 'vote_added':
      return record.detail ? `Vote: ${record.detail}` : 'Vote recorded'
    case 'title_changed':
      return 'Title updated'
    case 'description_changed':
      return 'Description updated'
    case 'hearing_added':
      return record.newValue ? `Hearing scheduled: ${record.newValue}` : 'Hearing scheduled'
    case 'hearing_changed':
      return record.newValue ? `Hearing updated: ${record.newValue}` : 'Hearing updated'
    case 'hearing_cancelled':
      return record.newValue ? `Hearing cancelled: ${record.newValue}` : 'Hearing cancelled'
    default:
      return 'Bill updated'
  }
}
