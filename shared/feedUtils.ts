import { dbTsToEpoch, dbTsToLocalDay } from './time'

export type FeedEvent = {
  id: string
  type: 'bill_added' | 'priority_set' | 'position_set' | 'comment_added' | 'vote_milestone' | 'bill_updated' | 'hearing_added' | 'hearing_changed' | 'hearing_cancelled' | 'bill_matched' | 'new_matches' | 'no_priority_updates'
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
  // Whether the bill's card is an untriaged new match (see **New match** in
  // CONTEXT.md): a keyword match with no priority that no one in its companion
  // group has triaged. Optional, like the fields below, because producers other
  // than GET /feed build FeedEvent-shaped objects; absent is read as "no".
  billNewMatch?: boolean
  // Optional because several non-feed producers build FeedEvent-shaped objects
  // (api/src/lib/digestEmail.ts, api/src/lib/mentions.ts); absent is read as
  // "not a draft". The card model reads it to label an untitled draft.
  billIsDraft?: boolean
  // The key of the bill's companion group (see **Companion group** in CONTEXT.md),
  // or null for a bill in no group. Events on any member share it, so the feed rolls
  // them into one card. Optional because producers other than GET /feed build
  // FeedEvent-shaped objects; absent is read as "in no group".
  billGroupKey?: string | null
  // A legislative update on the one bill (or companion group) its UTC day's
  // no-priority updates row resolved to: GET /feed sends that entry's updates in
  // the row's place, to be drawn as its card (#921). Passive like the row, so it
  // raises no "New activity" banner. Optional because producers other than GET
  // /feed build FeedEvent-shaped objects; absent is read as "no".
  noPriorityCard?: boolean
  userId: string
  userName: string
  userTitle: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

/** A bill with events in a group's card, as the card's header and its rows name it. */
export type GroupedBill = {
  billId: string | null
  billNumber: string
  billState: string | null
  billSessionSlug: string | null
  billIsDraft: boolean
}

export type GroupedBillEvents = {
  // `${billId}::${date}`, `group:${groupKey}::${date}` for a companion group, or `event:${eventId}::${date}` for a bill-less event
  key: string
  // Null for a bill-less event, which is always a group of exactly that one event.
  billId: string | null
  billNumber: string
  billTitle: string
  billSessionSlug: string | null
  billState: string | null
  billSummary: string | null
  billPriority: string | null
  billMatchType: 'keyword' | 'manual' | null
  /** The card's bill (or companion group) is an untriaged new match. Absent is read as no. */
  billNewMatch?: boolean
  billIsDraft?: boolean
  /** The companion group the card stands for, or null for a bill in no group. Absent is read as null. */
  groupKey?: string | null
  /**
   * The bills with events in a group's card, the newest event's bill first and
   * each once. Only a group's card has it: one card, many bills, so each row
   * names its bill and the header lists them. The fields above describe the
   * first of them.
   */
  bills?: GroupedBill[]
  date: string         // YYYY-MM-DD
  events: FeedEvent[]
}

// The time an event is filed under the viewer's day by. The no-priority updates
// row keeps its UTC day's first update as its time, which orders it on the
// server, and GET /feed sends its newest update's time as metadata.lastAt: the
// viewer's day of that one is the day it stands for, for them.
function dayTimeOf(e: FeedEvent): string {
  return e.type === 'no_priority_updates' && typeof e.metadata.lastAt === 'string' ? e.metadata.lastAt : e.createdAt
}

export function groupEventsByBillAndDay(events: FeedEvent[]): GroupedBillEvents[] {
  const map = new Map<string, GroupedBillEvents>()
  for (const e of events) {
    const date = dbTsToLocalDay(dayTimeOf(e))
    // A bill-less event has no bill to share a group with, so it is its own group.
    // A companion group is one policy: its members' events share a card.
    const groupKey = e.billId === null ? null : (e.billGroupKey ?? null)
    const key = groupKey !== null ? `group:${groupKey}::${date}` : `${e.billId ?? `event:${e.id}`}::${date}`
    if (!map.has(key)) {
      map.set(key, {
        key, billId: e.billId, billNumber: e.billNumber,
        billTitle: e.billTitle, billSessionSlug: e.billSessionSlug, billState: e.billState,
        billSummary: e.billSummary, billPriority: e.billPriority, billMatchType: e.billMatchType,
        billNewMatch: e.billNewMatch ?? false,
        billIsDraft: e.billIsDraft ?? false,
        groupKey,
        ...(groupKey !== null ? { bills: [] } : {}),
        date, events: [],
      })
    }
    const g = map.get(key)!
    g.events.push(e)
    if (g.bills && !g.bills.some(b => b.billId === e.billId)) {
      g.bills.push({
        billId: e.billId, billNumber: e.billNumber, billState: e.billState,
        billSessionSlug: e.billSessionSlug, billIsDraft: e.billIsDraft ?? false,
      })
    }
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
//
// The no-priority updates row is passive too: it stands for legislative events,
// so it never lights the dot, and the default feed admits it by its own rule
// (below and in the feed route), not as engagement.
export const PASSIVE_EVENT_TYPES = new Set<FeedEvent['type']>([
  'bill_updated', 'hearing_added', 'hearing_changed', 'hearing_cancelled', 'bill_matched', 'no_priority_updates',
])

/**
 * The type of the feed's one row a day for legislative activity on analyzed
 * bills with no priority (see **No-priority updates row** in CONTEXT.md). A
 * bill-less event: GET /feed resolves which bills it stands for on every read
 * and sends their count, and leaves out a row that resolves to none.
 */
export const NO_PRIORITY_UPDATES = 'no_priority_updates' satisfies FeedEvent['type']

/**
 * The passive events that put a bill in the no-priority updates row: a
 * legislative change to the bill (status, action, text, sponsor, vote) or to
 * one of its hearings. A match is not one: the new-matches row covers it.
 */
export const LEGISLATIVE_EVENT_TYPES: ReadonlyArray<FeedEvent['type']> = [
  'bill_updated', 'hearing_added', 'hearing_changed', 'hearing_cancelled',
]

export function filterPriorityEvents(groups: GroupedBillEvents[]): GroupedBillEvents[] {
  return groups.filter(group =>
    group.billPriority !== null ||
    group.events.some(e => !PASSIVE_EVENT_TYPES.has(e.type)) ||
    // The server sends the row only when it stands for two or more entries
    // (one, after an admin prioritizes from it in place, until the next load).
    group.events.some(e => e.type === NO_PRIORITY_UPDATES && Number(e.metadata.count) > 0) ||
    // A row of one: the server sends that bill's updates as its card instead.
    group.events.some(e => e.noPriorityCard === true)
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
