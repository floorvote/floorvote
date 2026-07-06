import { describe, it, expect } from 'vitest'
import { groupEventsByBillAndDay, type FeedEvent } from './feedUtils'

function ev(id: string, billId: string, createdAt: string): FeedEvent {
  return {
    id, type: 'priority_set', billId, billNumber: 'H 1', billSessionSlug: null,
    billState: null, billTitle: 't', billSummary: null, billPriority: 'high',
    billMatchType: 'keyword', userId: 'u', userName: 'U', userSubtitle: null,
    metadata: {}, createdAt,
  }
}

describe('groupEventsByBillAndDay mixed-format ordering', () => {
  it('orders a space-format 14:00 group above an ISO 09:00 group (same day)', () => {
    // Two different bills, same calendar day; group sort key is events[0].createdAt.
    const events: FeedEvent[] = [
      ev('a', 'bill-iso', '2026-06-06T09:00:00.000Z'),   // ISO, earlier
      ev('b', 'bill-space', '2026-06-06 14:00:00'),       // space, later
    ]
    const groups = groupEventsByBillAndDay(events)
    expect(groups.map((g) => g.billId)).toEqual(['bill-space', 'bill-iso'])
  })
})
