import { describe, it, expect } from 'vitest'
import { COMMENT_PREVIEW_MAX, groupEventsByBillAndDay, truncateWithEllipsis, type FeedEvent } from './feedUtils'

function ev(id: string, billId: string, createdAt: string): FeedEvent {
  return {
    id, type: 'priority_set', billId, billNumber: 'H 1', billSessionSlug: null,
    billState: null, billTitle: 't', billSummary: null, billPriority: 'high',
    billMatchType: 'keyword', userId: 'u', userName: 'U', userTitle: null,
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

describe('truncateWithEllipsis', () => {
  it('leaves a string at or under the cap untouched', () => {
    expect(truncateWithEllipsis('short', COMMENT_PREVIEW_MAX)).toBe('short')
    expect(truncateWithEllipsis('x'.repeat(COMMENT_PREVIEW_MAX), COMMENT_PREVIEW_MAX)).toBe('x'.repeat(COMMENT_PREVIEW_MAX))
  })
  it('marks a cut string with an ellipsis', () => {
    const out = truncateWithEllipsis('x'.repeat(COMMENT_PREVIEW_MAX + 5), COMMENT_PREVIEW_MAX)
    expect(out).toBe(`${'x'.repeat(COMMENT_PREVIEW_MAX)}…`)
  })
  it('drops the trailing space so the ellipsis sits against the last word', () => {
    expect(truncateWithEllipsis('ab cdef', 3)).toBe('ab…')
  })
})

describe('groupEventsByBillAndDay: the new-match flag', () => {
  it('carries a bill\'s untriaged-new-match flag onto its group', () => {
    const [g] = groupEventsByBillAndDay([{ ...ev('a', 'b1', '2026-06-06 09:00:00'), billNewMatch: true }])
    expect(g.billNewMatch).toBe(true)
  })

  it('reads an event with no flag as not a new match', () => {
    const [g] = groupEventsByBillAndDay([ev('a', 'b1', '2026-06-06 09:00:00')])
    expect(g.billNewMatch).toBe(false)
  })

  it('gives a companion group\'s card the flag of its events', () => {
    const [g] = groupEventsByBillAndDay([
      { ...ev('a', 'b1', '2026-06-06 09:00:00'), billGroupKey: 'b1', billNewMatch: true },
      { ...ev('b', 'b2', '2026-06-06 10:00:00'), billGroupKey: 'b1', billNewMatch: true },
    ])
    expect(g.billNewMatch).toBe(true)
  })
})

// A companion group's no-priority card (#921) is named by the group's lead bill,
// which GET /feed sends on the card's updates as groupLead (#945): the card's
// title, summary, and priority dropdown are the lead's, whichever member moved.
describe('groupEventsByBillAndDay: a no-priority card named by its group\'s lead', () => {
  const lead = { id: 'sb100', billNumber: 'SB 100', title: 'Act on SB 100', state: 'XX', sessionSlug: '2026', isDraft: false, groupKey: 'g', summary: 'The group\'s analysis.' }
  const update = (id: string, billId: string, billNumber: string, createdAt: string): FeedEvent => ({
    ...ev(id, billId, createdAt), billNumber, billTitle: `Act on ${billNumber}`, billSummary: null, billGroupKey: 'g', noPriorityCard: true, groupLead: lead,
  })

  it('names the card by the lead, its header listing the lead first and then the members that moved', () => {
    const [g] = groupEventsByBillAndDay([update('a', 'hb200', 'HB 200', '2026-06-06 10:00:00'), update('b', 'hb300', 'HB 300', '2026-06-06 09:00:00')])
    expect(g).toMatchObject({ billId: 'sb100', billNumber: 'SB 100', billTitle: 'Act on SB 100', billSummary: 'The group\'s analysis.', billState: 'XX', billSessionSlug: '2026', groupKey: 'g' })
    expect(g.bills!.map((b) => b.billId)).toEqual(['sb100', 'hb200', 'hb300'])
    expect(g.events.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('lists the lead once when it is the member that moved, with the group\'s analysis rather than its own', () => {
    const [g] = groupEventsByBillAndDay([{ ...update('a', 'sb100', 'SB 100', '2026-06-06 10:00:00'), billSummary: 'Its own, older analysis.' }])
    expect(g.billId).toBe('sb100')
    expect(g.billSummary).toBe('The group\'s analysis.')
    expect(g.bills!.map((b) => b.billId)).toEqual(['sb100'])
  })

  it('leaves a card with no lead named by its newest update\'s bill, as before', () => {
    const [g] = groupEventsByBillAndDay([{ ...ev('a', 'hb200', '2026-06-06 10:00:00'), billGroupKey: 'g' }])
    expect(g.billId).toBe('hb200')
    expect(g.bills!.map((b) => b.billId)).toEqual(['hb200'])
  })
})
