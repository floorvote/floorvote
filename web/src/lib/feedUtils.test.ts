import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { groupEventsByBillAndDay, filterPriorityEvents, filterFullyAnalyzed, formatBillUpdateDetail, stripHtml } from './feedUtils'
import type { FeedEvent, GroupedBillEvents } from './feedUtils'

// Day bucketing/labeling is timezone-sensitive by design — it must read in the
// viewer's local time, not UTC. Pin a negative-offset zone so these assertions
// are deterministic regardless of the CI runner's TZ. (Node re-reads
// process.env.TZ at runtime.)
const originalTz = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/New_York' })
afterAll(() => { process.env.TZ = originalTz })

function makeEvent(overrides: Partial<FeedEvent> & { billId: string | null; createdAt: string }): FeedEvent {
  return {
    id: overrides.id ?? `evt-${Math.random()}`,
    type: overrides.type ?? 'bill_added',
    billId: overrides.billId,
    billNumber: overrides.billNumber ?? (overrides.billId === null ? '' : 'HB 1'),
    billSessionSlug: overrides.billSessionSlug ?? (overrides.billId === null ? null : '2026'),
    billState: overrides.billState ?? (overrides.billId === null ? null : 'RI'),
    billTitle: overrides.billTitle ?? (overrides.billId === null ? '' : 'Test Bill'),
    billSummary: overrides.billSummary ?? null,
    billPriority: overrides.billPriority ?? null,
    billMatchType: overrides.billMatchType ?? null,
    billIsDraft: overrides.billIsDraft,
    billGroupKey: overrides.billGroupKey,
    userId: overrides.userId ?? 'user-1',
    userName: overrides.userName ?? 'Alice',
    userTitle: overrides.userTitle ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt,
  }
}

// ── groupEventsByBillAndDay ──────────────────────────────────────────────────

describe('groupEventsByBillAndDay', () => {
  it('groups same bill+day into one group', () => {
    const events = [
      makeEvent({ billId: 'b1', createdAt: '2026-04-20T10:00:00Z' }),
      makeEvent({ billId: 'b1', createdAt: '2026-04-20T14:00:00Z' }),
    ]
    const groups = groupEventsByBillAndDay(events)
    expect(groups).toHaveLength(1)
    expect(groups[0].events).toHaveLength(2)
    expect(groups[0].billId).toBe('b1')
    expect(groups[0].date).toBe('2026-04-20')
  })

  it('separates different bills on the same day', () => {
    const events = [
      makeEvent({ billId: 'b1', billNumber: 'HB 1', createdAt: '2026-04-20T10:00:00Z' }),
      makeEvent({ billId: 'b2', billNumber: 'HB 2', createdAt: '2026-04-20T11:00:00Z' }),
    ]
    const groups = groupEventsByBillAndDay(events)
    expect(groups).toHaveLength(2)
    const billIds = groups.map(g => g.billId)
    expect(billIds).toContain('b1')
    expect(billIds).toContain('b2')
  })

  it('separates same bill on different days', () => {
    const events = [
      makeEvent({ billId: 'b1', createdAt: '2026-04-20T10:00:00Z' }),
      makeEvent({ billId: 'b1', createdAt: '2026-04-21T10:00:00Z' }),
    ]
    const groups = groupEventsByBillAndDay(events)
    expect(groups).toHaveLength(2)
    const dates = groups.map(g => g.date)
    expect(dates).toContain('2026-04-20')
    expect(dates).toContain('2026-04-21')
  })

  it('sorts most-recent first', () => {
    const events = [
      makeEvent({ billId: 'b1', createdAt: '2026-04-20T10:00:00Z' }),
      makeEvent({ billId: 'b2', createdAt: '2026-04-22T10:00:00Z' }),
      makeEvent({ billId: 'b3', createdAt: '2026-04-21T10:00:00Z' }),
    ]
    const groups = groupEventsByBillAndDay(events)
    expect(groups[0].billId).toBe('b2')
    expect(groups[1].billId).toBe('b3')
    expect(groups[2].billId).toBe('b1')
  })

  it('returns empty array for empty input', () => {
    expect(groupEventsByBillAndDay([])).toHaveLength(0)
  })

  it('carries billMatchType from the first event into the group', () => {
    const events = [
      makeEvent({ billId: 'b1', billMatchType: 'keyword', createdAt: '2026-04-20T10:00:00Z' }),
      makeEvent({ billId: 'b1', billMatchType: 'keyword', createdAt: '2026-04-20T11:00:00Z' }),
    ]
    const groups = groupEventsByBillAndDay(events)
    expect(groups[0].billMatchType).toBe('keyword')
  })

  it('buckets an instant by the viewer local day, not its UTC date', () => {
    // 2026-06-08 00:30:00 UTC == 2026-06-07 20:30 EDT — still June 7 locally.
    // Naive .slice(0,10) of the UTC string would mis-bucket it to June 8.
    const events = [makeEvent({ billId: 'b1', createdAt: '2026-06-08 00:30:00' })]
    const groups = groupEventsByBillAndDay(events)
    expect(groups[0].date).toBe('2026-06-07')
  })
})

// A bill-less event (a bulk edit) belongs to no bill, so it can't share a group
// with anything: each one is its own group, rendered as its own activity row.
describe('groupEventsByBillAndDay with bill-less events', () => {
  const billless = (id: string, createdAt: string) =>
    makeEvent({ id, billId: null, type: 'priority_set', createdAt, metadata: { priority: 'high', count: 11, billIds: ['b1'] } })

  it('gives each bill-less event its own group, never merging two on the same day', () => {
    const groups = groupEventsByBillAndDay([
      billless('e1', '2026-04-20T10:00:00Z'),
      billless('e2', '2026-04-20T11:00:00Z'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.billId === null && g.events.length === 1)).toBe(true)
    expect(new Set(groups.map((g) => g.key)).size).toBe(2)
  })

  it('orders them among per-bill groups by time, and keeps per-bill grouping intact', () => {
    const groups = groupEventsByBillAndDay([
      makeEvent({ id: 'a1', billId: 'b1', createdAt: '2026-04-20T09:00:00Z' }),
      billless('bulk', '2026-04-20T10:00:00Z'),
      makeEvent({ id: 'a2', billId: 'b1', createdAt: '2026-04-20T08:00:00Z' }),
      makeEvent({ id: 'c1', billId: 'b2', createdAt: '2026-04-20T11:00:00Z' }),
    ])
    expect(groups.map((g) => g.events.map((e) => e.id))).toEqual([['c1'], ['bulk'], ['a1', 'a2']])
  })

  it('does not merge a bill-less event into a bill whose id it names', () => {
    const groups = groupEventsByBillAndDay([
      makeEvent({ id: 'a1', billId: 'b1', createdAt: '2026-04-20T09:00:00Z' }),
      billless('bulk', '2026-04-20T10:00:00Z'),
    ])
    expect(groups.find((g) => g.billId === 'b1')!.events.map((e) => e.id)).toEqual(['a1'])
  })
})

// ── filterPriorityEvents ──────────────────────────────────────────────────────

describe('filterPriorityEvents', () => {
  function makeGroup(overrides: { billPriority: string | null; billMatchType?: 'keyword' | 'manual' | null; events: FeedEvent[] }): GroupedBillEvents {
    return {
      key: 'bill-1::2026-04-20',
      billId: 'bill-1',
      billNumber: 'S1234',
      billSessionSlug: '2026',
      billState: 'RI',
      billTitle: 'Test Bill',
      billSummary: null,
      billPriority: overrides.billPriority,
      billMatchType: overrides.billMatchType ?? null,
      events: overrides.events,
      date: '2026-04-20',
    }
  }

  it('keeps all events for priority bills', () => {
    const group = makeGroup({
      billPriority: 'high',
      events: [
        makeEvent({ billId: 'b1', type: 'bill_updated', createdAt: '2026-04-20T10:00:00Z' }),
        makeEvent({ billId: 'b1', type: 'priority_set', createdAt: '2026-04-20T09:00:00Z' }),
      ],
    })
    const result = filterPriorityEvents([group])
    expect(result).toHaveLength(1)
    expect(result[0].events).toHaveLength(2)
  })

  it('keeps a priority bill whose only event is a hearing change', () => {
    const group = makeGroup({
      billPriority: 'medium',
      events: [makeEvent({ billId: 'b1', type: 'hearing_changed', createdAt: '2026-04-20T10:00:00Z' })],
    })
    expect(filterPriorityEvents([group])).toHaveLength(1)
  })

  it('keeps all same-day events (incl. bill_updated and hearing_changed) when a non-priority bill has engagement that day', () => {
    const group = makeGroup({
      billPriority: null,
      events: [
        makeEvent({ billId: 'b1', type: 'bill_updated', createdAt: '2026-04-20T11:00:00Z' }),
        makeEvent({ billId: 'b1', type: 'hearing_changed', createdAt: '2026-04-20T10:30:00Z' }),
        makeEvent({ billId: 'b1', type: 'comment_added', createdAt: '2026-04-20T09:00:00Z' }),
      ],
    })
    const result = filterPriorityEvents([group])
    expect(result).toHaveLength(1)
    expect(result[0].events).toHaveLength(3)
  })

  it('surfaces a non-priority group whose engagement is a vote or position', () => {
    const voteGroup = makeGroup({
      billPriority: null,
      events: [makeEvent({ billId: 'b1', type: 'vote_milestone', createdAt: '2026-04-20T10:00:00Z' })],
    })
    const positionGroup = makeGroup({
      billPriority: null,
      events: [makeEvent({ billId: 'b1', type: 'position_set', createdAt: '2026-04-20T10:00:00Z' })],
    })
    expect(filterPriorityEvents([voteGroup])).toHaveLength(1)
    expect(filterPriorityEvents([positionGroup])).toHaveLength(1)
  })

  it('removes a non-priority group whose only event is bill_updated', () => {
    const group = makeGroup({
      billPriority: null,
      events: [makeEvent({ billId: 'b1', type: 'bill_updated', createdAt: '2026-04-20T10:00:00Z' })],
    })
    expect(filterPriorityEvents([group])).toHaveLength(0)
  })

  it('removes a non-priority group whose only events are hearing changes (the SB1414 leak)', () => {
    const group = makeGroup({
      billPriority: null,
      events: [
        makeEvent({ billId: 'b1', type: 'hearing_changed', createdAt: '2026-04-20T10:00:00Z' }),
        makeEvent({ billId: 'b1', type: 'hearing_added', createdAt: '2026-04-20T09:00:00Z' }),
      ],
    })
    expect(filterPriorityEvents([group])).toHaveLength(0)
  })

  it('handles empty input', () => {
    expect(filterPriorityEvents([])).toHaveLength(0)
  })
})

// ── filterFullyAnalyzed ──────────────────────────────────────────────────────

describe('filterFullyAnalyzed', () => {
  function makeGroup(overrides: { billMatchType: 'keyword' | 'manual' | null; events: FeedEvent[] }): GroupedBillEvents {
    return {
      key: `bill-${overrides.billMatchType}::2026-04-20`,
      billId: 'bill-1',
      billNumber: 'S1234',
      billSessionSlug: '2026',
      billState: 'RI',
      billTitle: 'Test Bill',
      billSummary: null,
      billPriority: null,
      billMatchType: overrides.billMatchType,
      events: overrides.events,
      date: '2026-04-20',
    }
  }

  it('keeps groups with billMatchType keyword', () => {
    const group = makeGroup({
      billMatchType: 'keyword',
      events: [makeEvent({ billId: 'b1', type: 'bill_updated', createdAt: '2026-04-20T10:00:00Z' })],
    })
    expect(filterFullyAnalyzed([group])).toHaveLength(1)
  })

  it('keeps groups with billMatchType manual', () => {
    const group = makeGroup({
      billMatchType: 'manual',
      events: [makeEvent({ billId: 'b1', type: 'comment_added', createdAt: '2026-04-20T10:00:00Z' })],
    })
    expect(filterFullyAnalyzed([group])).toHaveLength(1)
  })

  it('removes groups with billMatchType null', () => {
    const group = makeGroup({
      billMatchType: null,
      events: [makeEvent({ billId: 'b1', type: 'bill_updated', createdAt: '2026-04-20T10:00:00Z' })],
    })
    expect(filterFullyAnalyzed([group])).toHaveLength(0)
  })

  it('keeps all event types for included groups (does not strip bill_updated)', () => {
    const group = makeGroup({
      billMatchType: 'keyword',
      events: [
        makeEvent({ billId: 'b1', type: 'bill_updated', createdAt: '2026-04-20T10:00:00Z' }),
        makeEvent({ billId: 'b1', type: 'comment_added', createdAt: '2026-04-20T09:00:00Z' }),
      ],
    })
    const result = filterFullyAnalyzed([group])
    expect(result[0].events).toHaveLength(2)
  })

  it('handles empty input', () => {
    expect(filterFullyAnalyzed([])).toHaveLength(0)
  })
})

describe('filters with bill-less events', () => {
  const group = (type: FeedEvent['type']) => groupEventsByBillAndDay([
    makeEvent({ billId: null, type, createdAt: '2026-04-20T10:00:00Z' }),
  ])

  it('filterPriorityEvents keeps a bill-less engagement event and drops a bill-less passive one', () => {
    expect(filterPriorityEvents(group('priority_set'))).toHaveLength(1)
    expect(filterPriorityEvents(group('bill_matched'))).toHaveLength(0)
  })

  it('filterFullyAnalyzed keeps a bill-less event, which has no bill to be unanalyzed', () => {
    expect(filterFullyAnalyzed(group('priority_set'))).toHaveLength(1)
  })
})

// ── formatBillUpdateDetail ───────────────────────────────────────────────────

describe('formatBillUpdateDetail', () => {
  it('formats status_change with old and new values', () => {
    expect(formatBillUpdateDetail({ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Enrolled', detail: null }))
      .toBe('Status: Introduced → Enrolled')
  })

  it('formats action_added using newValue', () => {
    expect(formatBillUpdateDetail({ changeType: 'action_added', oldValue: null, newValue: 'Referred to Senate Judiciary', detail: '2026-04-20' }))
      .toBe('Action: Referred to Senate Judiciary')
  })

  it('formats action_added without newValue', () => {
    expect(formatBillUpdateDetail({ changeType: 'action_added', oldValue: null, newValue: null, detail: null }))
      .toBe('New action')
  })

  it('formats text_added using detail as type name', () => {
    expect(formatBillUpdateDetail({ changeType: 'text_added', oldValue: null, newValue: '12345', detail: 'Enrolled' }))
      .toBe('New text: Enrolled')
  })

  it('formats text_added without detail', () => {
    expect(formatBillUpdateDetail({ changeType: 'text_added', oldValue: null, newValue: '12345', detail: null }))
      .toBe('New text version')
  })

  it('formats amendment_added with detail', () => {
    expect(formatBillUpdateDetail({ changeType: 'amendment_added', oldValue: null, newValue: '99', detail: 'Senate Amendment 1' }))
      .toBe('Amendment added: Senate Amendment 1')
  })

  it('formats amendment_added without detail', () => {
    expect(formatBillUpdateDetail({ changeType: 'amendment_added', oldValue: null, newValue: '99', detail: null }))
      .toBe('Amendment added')
  })

  it('formats supplement_added with detail', () => {
    expect(formatBillUpdateDetail({ changeType: 'supplement_added', oldValue: null, newValue: '55', detail: 'Fiscal Note' }))
      .toBe('Document added: Fiscal Note')
  })

  it('formats sponsor_added', () => {
    expect(formatBillUpdateDetail({ changeType: 'sponsor_added', oldValue: null, newValue: 'Sen. Jane Smith (D)', detail: null }))
      .toBe('Sponsor added: Sen. Jane Smith (D)')
  })

  it('formats sponsor_removed', () => {
    expect(formatBillUpdateDetail({ changeType: 'sponsor_removed', oldValue: 'Sen. Tom Jones (R)', newValue: null, detail: null }))
      .toBe('Sponsor removed: Sen. Tom Jones (R)')
  })

  it('formats vote_added using detail', () => {
    expect(formatBillUpdateDetail({ changeType: 'vote_added', oldValue: null, newValue: '123', detail: 'Yea 35 Nay 5' }))
      .toBe('Vote: Yea 35 Nay 5')
  })

  it('formats vote_added without detail', () => {
    expect(formatBillUpdateDetail({ changeType: 'vote_added', oldValue: null, newValue: '123', detail: null }))
      .toBe('Vote recorded')
  })

  it('formats title_changed', () => {
    expect(formatBillUpdateDetail({ changeType: 'title_changed', oldValue: 'Old Title', newValue: 'New Title', detail: null }))
      .toBe('Title updated')
  })

  it('formats description_changed', () => {
    expect(formatBillUpdateDetail({ changeType: 'description_changed', oldValue: 'a', newValue: 'b', detail: null }))
      .toBe('Description updated')
  })

  it('falls back to "Bill updated" for unknown changeType', () => {
    expect(formatBillUpdateDetail({ changeType: 'unknown_xyz', oldValue: null, newValue: null, detail: null }))
      .toBe('Bill updated')
  })
})

// ── stripHtml ─────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes simple tags', () => {
    expect(stripHtml('<p>Hello world</p>')).toBe('Hello world')
  })

  it('removes nested tags', () => {
    expect(stripHtml('<ul><li>Sets the maximum award</li><li>Other item</li></ul>'))
      .toBe('Sets the maximum award Other item')
  })

  it('collapses whitespace runs to a single space', () => {
    expect(stripHtml('foo   <br/>   bar')).toBe('foo bar')
  })

  it('trims leading and trailing whitespace', () => {
    expect(stripHtml('  <em>hello</em>  ')).toBe('hello')
  })

  it('leaves plain text unchanged', () => {
    expect(stripHtml('plain text here')).toBe('plain text here')
  })

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('')
  })

  it('handles self-closing tags', () => {
    expect(stripHtml('line one<br/>line two')).toBe('line one line two')
  })

  it('strips tags with attributes', () => {
    expect(stripHtml('<a href="https://example.com">link text</a>')).toBe('link text')
  })
})

// ── companion groups (#381) ─────────────────────────────────────────────────
//
// A companion group is one policy: the feed shows one card per group per day,
// whichever member an event is on. The API tags each event with the group key
// of its bill (null for a bill in no group).

describe('groupEventsByBillAndDay: companion groups', () => {
  const house = (createdAt: string, over: Partial<FeedEvent> = {}) =>
    makeEvent({ billId: 'h1', billNumber: 'H 101', billGroupKey: 'h1', createdAt, ...over })
  const senate = (createdAt: string, over: Partial<FeedEvent> = {}) =>
    makeEvent({ billId: 's1', billNumber: 'S 202', billGroupKey: 'h1', createdAt, ...over })

  it('rolls both members\' same-day events into one card keyed by the group', () => {
    const groups = groupEventsByBillAndDay([
      senate('2026-04-20T14:00:00Z', { id: 'e3' }),
      house('2026-04-20T12:00:00Z', { id: 'e2' }),
      senate('2026-04-20T10:00:00Z', { id: 'e1' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('group:h1::2026-04-20')
    expect(groups[0].groupKey).toBe('h1')
    expect(groups[0].events.map(e => e.id)).toEqual(['e3', 'e2', 'e1'])
  })

  it('lists the bills in the card, the newest event\'s bill first, each once', () => {
    const [g] = groupEventsByBillAndDay([
      senate('2026-04-20T14:00:00Z'), house('2026-04-20T12:00:00Z'), senate('2026-04-20T10:00:00Z'),
    ])
    expect(g.bills!.map(b => b.billNumber)).toEqual(['S 202', 'H 101'])
    expect(g.billNumber).toBe('S 202')
    expect(g.bills![0]).toMatchObject({ billId: 's1', billState: 'RI', billSessionSlug: '2026', billIsDraft: false })
  })

  it('makes one card per group per day', () => {
    const groups = groupEventsByBillAndDay([
      house('2026-04-21T10:00:00Z'), senate('2026-04-21T11:00:00Z'),
      house('2026-04-20T10:00:00Z'), senate('2026-04-20T11:00:00Z'),
    ])
    expect(groups.map(g => g.date)).toEqual(['2026-04-21', '2026-04-20'])
    expect(groups.every(g => g.events.length === 2)).toBe(true)
  })

  it('keeps two groups apart on the same day', () => {
    const groups = groupEventsByBillAndDay([
      house('2026-04-20T10:00:00Z'), senate('2026-04-20T11:00:00Z'),
      makeEvent({ billId: 'k1', billNumber: 'H 601', billGroupKey: 'k1', createdAt: '2026-04-20T12:00:00Z' }),
      makeEvent({ billId: 'k2', billNumber: 'S 602', billGroupKey: 'k1', createdAt: '2026-04-20T13:00:00Z' }),
    ])
    expect(groups.map(g => g.groupKey).sort()).toEqual(['h1', 'k1'])
  })

  it('still makes a group card when only one member had events', () => {
    const [g] = groupEventsByBillAndDay([senate('2026-04-20T10:00:00Z')])
    expect(g.groupKey).toBe('h1')
    expect(g.bills!.map(b => b.billNumber)).toEqual(['S 202'])
  })

  it('flags a draft member in the card\'s bills', () => {
    const [g] = groupEventsByBillAndDay([
      senate('2026-04-20T11:00:00Z', { billIsDraft: true }), house('2026-04-20T10:00:00Z'),
    ])
    expect(g.bills!.find(b => b.billNumber === 'S 202')!.billIsDraft).toBe(true)
    expect(g.bills!.find(b => b.billNumber === 'H 101')!.billIsDraft).toBe(false)
  })

  it('leaves a bill in no group exactly as it was: keyed by the bill, no group, no bills list', () => {
    const [g] = groupEventsByBillAndDay([
      makeEvent({ billId: 'b9', billNumber: 'HB 9', createdAt: '2026-04-20T10:00:00Z' }),
      makeEvent({ billId: 'b9', billNumber: 'HB 9', billGroupKey: null, createdAt: '2026-04-20T11:00:00Z' }),
    ])
    expect(g.key).toBe('b9::2026-04-20')
    expect(g.groupKey).toBeNull()
    expect(g.bills).toBeUndefined()
  })

  it('keeps a group apart from an ungrouped bill whose id happens to equal the group key', () => {
    const groups = groupEventsByBillAndDay([
      house('2026-04-20T10:00:00Z'),
      makeEvent({ billId: 'h1', billNumber: 'H 101', billGroupKey: null, createdAt: '2026-04-20T11:00:00Z' }),
    ])
    // Same member id, one tagged and one not (the group changed between two reads): one card each, never a crash.
    expect(groups).toHaveLength(2)
  })

  it('sorts cards across groups and bills by their newest event', () => {
    // The feed serves events newest first.
    const groups = groupEventsByBillAndDay([
      senate('2026-04-20T13:00:00Z'), house('2026-04-20T10:00:00Z'),
      makeEvent({ billId: 'b9', billNumber: 'HB 9', createdAt: '2026-04-20T09:00:00Z' }),
    ])
    expect(groups.map(g => g.billNumber)).toEqual(['S 202', 'HB 9'])
  })
})
