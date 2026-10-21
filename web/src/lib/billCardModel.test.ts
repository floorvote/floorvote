import { describe, it, expect } from 'vitest'
import { buildBillCardModel, billCardRowText, buildActivityRowModel, userEventIcon, USER_EVENT_ICONS } from './billCardModel'
import { PRIORITY_COLORS } from './chipStyles'
import { POSITION_FEED_ICON } from '../../../shared/billChipColors'
import { color } from '../styles/tokens'
import type { GroupedBillEvents, FeedEvent } from './feedUtils'

function group(events: Partial<FeedEvent>[], over: Partial<GroupedBillEvents> = {}): GroupedBillEvents {
  return {
    key: 'b1::2026-06-03', billId: 'b1', billNumber: 'H 5174', billTitle: 'Mail ballot processing',
    billSessionSlug: '2026', billState: 'RI', billSummary: 'A summary.', billPriority: 'high', billMatchType: 'keyword',
    date: '2026-06-03',
    events: events.map((e, i) => ({
      id: `e${i}`, type: 'bill_updated', billId: 'b1', billNumber: 'H 5174', billSessionSlug: '2026', billState: 'RI',
      billTitle: 'Mail ballot processing', billSummary: null, billPriority: 'high', billMatchType: 'keyword',
      userId: 'user-1', userName: 'Will', userTitle: null, metadata: {}, createdAt: '2026-06-03T10:00:00Z', ...e,
    })) as FeedEvent[],
    ...over,
  }
}

describe('buildBillCardModel', () => {
  it('carries bill-level fields and priority', () => {
    const m = buildBillCardModel(group([{ metadata: { changes: [{ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null }] } }]))
    expect(m.billNumber).toBe('H 5174'); expect(m.title).toBe('Mail ballot processing'); expect(m.priority).toBe('high'); expect(m.summary).toBe('A summary.')
  })
  it('one row per bill_updated change with label + icon name', () => {
    const m = buildBillCardModel(group([{ metadata: { changes: [
      { changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null },
      { changeType: 'text_added', oldValue: null, newValue: '101', detail: 'Amended' },
    ] } }]))
    expect(m.rows).toHaveLength(2)
    expect(m.rows[0].text).toContain('Status:'); expect(m.rows[0].iconName).toBe('flag'); expect(m.rows[1].iconName).toBe('description')
  })
  it('priority_set user event renders a priority square with the fill color', () => {
    const m = buildBillCardModel(group([{ type: 'priority_set', metadata: { priority: 'high' }, userName: 'Will' }]))
    expect(m.rows[0].text).toContain('high priority')
    expect(m.rows[0].square).toBe(true)
    expect(m.rows[0].iconColor).toBe(PRIORITY_COLORS.high.fill)
  })
  it('position_set user event with attribution', () => {
    const m = buildBillCardModel(group([{ type: 'position_set', metadata: { position: 'Support' }, userName: 'Will' }]))
    expect(m.rows[0].text).toContain('Position set to Support'); expect(m.rows[0].iconName).toBe('thumbs_up_down')
  })
  it('hearing events render a row with date/location text', () => {
    const m = buildBillCardModel(group([{ type: 'hearing_changed', metadata: { date: '2026-06-10', time: '14:00', location: 'Room 35', description: 'Cmte on Elections' } }]))
    expect(m.rows).toHaveLength(1); expect(m.rows[0].text).toContain('2026-06-10'); expect(m.rows[0].text).toContain('Cmte on Elections'); expect(m.rows[0].iconName).toBe('gavel')
    expect(m.rows[0].bg).toBe(color.surfaceSubtle)
  })
  it('bill_matched renders a single "matched your keywords" row with the new_releases icon', () => {
    const m = buildBillCardModel(group([{ type: 'bill_matched', metadata: {} }]))
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0].text).toMatch(/keyword/i)
    expect(m.rows[0].iconName).toBe('new_releases')
  })

  it('sets showTime on every row, including each change in a multi-change update', () => {
    const updated = buildBillCardModel(group([{ metadata: { changes: [
      { changeType: 'status_change', oldValue: 'a', newValue: 'b', detail: null },
      { changeType: 'text_added', oldValue: null, newValue: '101', detail: 'Amended' },
    ] } }]))
    expect(updated.rows[0].showTime).toBe(true)
    expect(updated.rows[1].showTime).toBe(true)
    const pos = buildBillCardModel(group([{ type: 'position_set', metadata: { position: 'Support' } }]))
    expect(pos.rows[0].showTime).toBe(true)
  })
  it('skips bill_updated with no changes', () => {
    expect(buildBillCardModel(group([{ metadata: {} }])).rows).toHaveLength(0)
  })
  it('omits all-day (00:00) hearing time but keeps real times', () => {
    const allDay = buildBillCardModel(group([{ type: 'hearing_added', metadata: { date: '2026-06-09', time: '00:00', location: 'Senate Judiciary', description: 'Consideration' } }]))
    expect(allDay.rows[0].text).toContain('2026-06-09')
    expect(allDay.rows[0].text).not.toContain('00:00')

    const timed = buildBillCardModel(group([{ type: 'hearing_added', metadata: { date: '2026-06-09', time: '14:00', location: 'Senate Judiciary', description: 'Consideration' } }]))
    expect(timed.rows[0].text).toContain('2:00 PM')
  })
})

describe('feed icon mapping', () => {
  it('uses arrow_forward for action_added changes', () => {
    const m = buildBillCardModel(group([{ metadata: { changes: [
      { changeType: 'action_added', oldValue: null, newValue: 'Referred', detail: null },
    ] } }]))
    expect(m.rows[0].iconName).toBe('arrow_forward')
  })

  it('uses gavel for hearing_added events', () => {
    const m = buildBillCardModel(group([{ type: 'hearing_added', metadata: { date: 'Jun 16', time: '10:00', location: 'Room 313' } }]))
    expect(m.rows[0].iconName).toBe('gavel')
  })
})

describe('buildActivityRowModel', () => {
  const event = (over: Partial<FeedEvent>): FeedEvent => ({
    id: 'e1', type: 'priority_set', billId: null, billNumber: '', billSessionSlug: null, billState: null,
    billTitle: '', billSummary: null, billPriority: null, billMatchType: null,
    userId: 'user-1', userName: 'Ada Admin', userTitle: null,
    metadata: { priority: 'high', count: 34, billIds: ['b1'] }, createdAt: '2026-06-03T10:00:00Z', ...over,
  })

  it('reads a bulk priority edit as one sentence with the priority square', () => {
    const m = buildActivityRowModel(event({}))
    expect(m.text).toBe('Ada Admin set priority to high on 34 bills')
    expect(m.square).toBe(true)
    expect(m.iconColor).toBe(PRIORITY_COLORS.high.fill)
    expect(m.billCount).toBe(34)
    expect(m.userId).toBe('user-1')
  })
  it('draws a bulk edit that cleared the priority as a hollow square', () => {
    expect(buildActivityRowModel(event({ metadata: { priority: null, count: 2 } }))).toMatchObject({ square: true, hollow: true, iconColor: color.borderDefault })
  })
  it('reads a bulk position edit, and a cleared position', () => {
    const set = buildActivityRowModel(event({ type: 'position_set', metadata: { position: 'Support', count: 12, billIds: [] } }))
    expect(set.text).toBe('Ada Admin set position to Support on 12 bills')
    expect(set.iconName).toBe('thumbs_up_down')
    const cleared = buildActivityRowModel(event({ type: 'position_set', metadata: { position: null, count: 12, billIds: [] } }))
    expect(cleared.text).toBe('Ada Admin cleared the position on 12 bills')
  })
  it('falls back to "An admin" when the author has no name, and counts the ids when count is missing', () => {
    const m = buildActivityRowModel(event({ userName: '', metadata: { priority: 'low', billIds: ['a', 'b', 'c'] } }))
    expect(m.text).toBe('An admin set priority to low on 3 bills')
    expect(m.billCount).toBe(3)
  })
  it('says "1 bill" for one', () => {
    expect(buildActivityRowModel(event({ metadata: { priority: 'high', count: 1, billIds: ['a'] } })).text).toBe('Ada Admin set priority to high on 1 bill')
  })
  it('reads the new-matches row as a count of bills, with no author', () => {
    const m = buildActivityRowModel(event({ type: 'new_matches', userId: 'system', userName: '', metadata: { billIds: ['a', 'b', 'c', 'd', 'e'] } }))
    expect(m.text).toBe('5 new bills matched your keywords')
    expect(m.iconName).toBe('new_releases')
    expect(m.billCount).toBe(5)
  })
  it('says "1 new bill matched" for one', () => {
    expect(buildActivityRowModel(event({ type: 'new_matches', metadata: { billIds: ['a'] } })).text).toBe('1 new bill matched your keywords')
  })
  it('renders a bill-less event of a type it has no wording for as plain activity', () => {
    const m = buildActivityRowModel(event({ type: 'bill_matched', metadata: {} }))
    expect(m.text).toBe('Activity')
    expect(m.billCount).toBeNull()
  })
})

// ── companion groups (#381) ─────────────────────────────────────────────────
// A group's card holds the events of every member bill. When its header shows
// more than one bill, each row is labeled with its bill's number so the reader
// knows which chamber's bill it happened on; with one, the header names it.

describe('buildBillCardModel: companion groups', () => {
  const member = (billId: string, billNumber: string, over: Partial<FeedEvent> = {}): Partial<FeedEvent> =>
    ({ billId, billNumber, billGroupKey: 'h1', ...over })
  const grouped = (events: Partial<FeedEvent>[]) => group(events, {
    key: 'group:h1::2026-06-03', groupKey: 'h1',
    bills: [
      { billId: 's1', billNumber: 'S 202', billState: 'RI', billSessionSlug: '2026', billIsDraft: false },
      { billId: 'h1', billNumber: 'H 101', billState: 'RI', billSessionSlug: '2026', billIsDraft: false },
    ],
  })

  it('labels each row with the number of the bill its event is on, and says which bill that is', () => {
    const m = buildBillCardModel(grouped([
      member('h1', 'H 101', { metadata: { changes: [{ changeType: 'action_added', newValue: 'Passed House committee' }] } }),
      member('s1', 'S 202', { metadata: { changes: [{ changeType: 'action_added', newValue: 'Reported from committee' }] } }),
    ]))
    expect(m.rows.map(r => [r.billLabel, r.billId, r.text])).toEqual([
      ['H 101', 'h1', 'Action: Passed House committee'],
      ['S 202', 's1', 'Action: Reported from committee'],
    ])
  })

  it('labels every kind of row: a hearing, a comment, a priority change', () => {
    const m = buildBillCardModel(grouped([
      member('s1', 'S 202', { type: 'hearing_added', metadata: { date: '2026-06-10', description: 'Senate Cmte' } }),
      member('h1', 'H 101', { type: 'comment_added', metadata: { preview: 'hello' } }),
      member('h1', 'H 101', { type: 'priority_set', metadata: { priority: 'high' } }),
    ]))
    expect(m.rows.map(r => r.billLabel)).toEqual(['S 202', 'H 101', 'H 101'])
  })

  it('leaves a lone member\'s rows unlabeled, since the header\'s one chip already names the bill', () => {
    const lone = group([
      member('s1', 'S 202', { metadata: { changes: [{ changeType: 'status_change', oldValue: 'a', newValue: 'b' }] } }),
      member('s1', 'S 202', { type: 'priority_set', metadata: { priority: 'medium' } }),
    ], {
      key: 'group:h1::2026-06-03', groupKey: 'h1',
      bills: [{ billId: 's1', billNumber: 'S 202', billState: 'RI', billSessionSlug: '2026', billIsDraft: false }],
    })
    const m = buildBillCardModel(lone)
    expect(m.rows.map(r => [r.billLabel, r.billId])).toEqual([[null, 's1'], [null, 's1']])
    expect(m.rows.map(r => billCardRowText(r))).toEqual(m.rows.map(r => r.text))
    expect(billCardRowText(m.rows[1])).toBe('Marked medium priority by Will')
  })

  it('leaves a group\'s rows unlabeled when the card carries no bills list for its header', () => {
    const m = buildBillCardModel(group([member('s1', 'S 202', { type: 'priority_set', metadata: { priority: 'high' } })], { key: 'group:h1::2026-06-03', groupKey: 'h1' }))
    expect(m.rows[0].billLabel).toBeNull()
  })

  it('labels a member\'s rows when the header shows another bill, even if only one had events', () => {
    // The no-priority list's entry shows a chip for every member, active or not.
    const m = buildBillCardModel(grouped([member('s1', 'S 202', { type: 'priority_set', metadata: { priority: 'low' } })]))
    expect(m.rows[0].billLabel).toBe('S 202')
  })

  it('carries the card\'s bills for the header', () => {
    const m = buildBillCardModel(grouped([member('s1', 'S 202')]))
    expect(m.bills!.map(b => b.billNumber)).toEqual(['S 202', 'H 101'])
  })

  it('leaves a bill in no group unlabeled, with no bills list', () => {
    const m = buildBillCardModel(group([{ metadata: { changes: [{ changeType: 'status_change', oldValue: 'a', newValue: 'b' }] } }]))
    expect(m.rows[0].billLabel).toBeNull()
    expect(m.rows[0].billId).toBe('b1')
    expect(m.bills).toBeUndefined()
  })
})

// One rule for the icon a person's change shows with, read by the feed, the
// digest, and the bill page's comment thread, so they can't drift.
describe('userEventIcon', () => {
  it('draws a priority change as the priority square in that level\'s fill color', () => {
    for (const level of ['high', 'medium', 'low'] as const) {
      expect(userEventIcon('priority_set', { priority: level })).toEqual({ name: 'flag', color: PRIORITY_COLORS[level].fill, fill: 1, square: true })
    }
  })

  it('draws a cleared priority as a hollow square in the no-priority border color', () => {
    expect(userEventIcon('priority_set', { priority: null })).toEqual({ name: 'flag', color: color.borderDefault, fill: 1, square: true, hollow: true })
  })

  it('carries a cleared priority through the card row and the bulk-edit row as hollow too', () => {
    const row = buildBillCardModel(group([{ type: 'priority_set', metadata: { priority: null }, userName: 'Will' }])).rows[0]
    expect(row).toMatchObject({ square: true, hollow: true, iconColor: color.borderDefault })
  })

  it('falls back to the table\'s priority color, still a filled square, for an unknown priority', () => {
    expect(userEventIcon('priority_set', { priority: 'urgent' })).toMatchObject({ color: USER_EVENT_ICONS.priority_set.color, square: true })
    expect(userEventIcon('priority_set', undefined)).toMatchObject({ color: USER_EVENT_ICONS.priority_set.color, square: true })
  })

  it('draws a position as the filled thumbs-up-down glyph in the position\'s color', () => {
    for (const [position, hex] of Object.entries(POSITION_FEED_ICON)) {
      expect(userEventIcon('position_set', { position })).toEqual({ name: 'thumbs_up_down', color: hex, fill: 1, square: false })
    }
  })

  it('falls back to the table\'s position color for a cleared position or one with no color', () => {
    expect(userEventIcon('position_set', { position: null })).toMatchObject({ color: USER_EVENT_ICONS.position_set.color, square: false })
    expect(userEventIcon('position_set', { position: 'Watching closely' })).toMatchObject({ color: USER_EVENT_ICONS.position_set.color })
  })

  it('draws a custom field change with the table\'s one custom field entry, in the same muted color as an amendment row', () => {
    expect(USER_EVENT_ICONS.custom_field_set).toBeDefined()
    expect(userEventIcon('custom_field_set', {})).toEqual({ name: 'edit_note', color: USER_EVENT_ICONS.custom_field_set.color, fill: 0, square: false })
    expect(USER_EVENT_ICONS.custom_field_set.color).toBe(color.textSecondary)
  })

  it('keeps the feed\'s fallback glyph for a type with no entry', () => {
    expect(userEventIcon('something_else', {})).toEqual({ name: 'circle', color: color.textMuted, fill: 0, square: false })
  })

  it('is what a feed card row shows for the same event, so the thread and the feed agree', () => {
    const priority = buildBillCardModel(group([{ type: 'priority_set', metadata: { priority: 'low' } }])).rows[0]
    expect(userEventIcon('priority_set', { priority: 'low' })).toEqual({ name: priority.iconName, color: priority.iconColor, fill: priority.iconFill, square: !!priority.square })
    const position = buildBillCardModel(group([{ type: 'position_set', metadata: { position: 'Oppose' } }])).rows[0]
    expect(userEventIcon('position_set', { position: 'Oppose' })).toEqual({ name: position.iconName, color: position.iconColor, fill: position.iconFill, square: !!position.square })
  })

  it('is what a bulk-edit row shows for the same event', () => {
    const bulk = buildActivityRowModel({ ...({} as FeedEvent), id: 'x', type: 'position_set', userId: 'u', userName: 'Ada', createdAt: '2026-06-03 10:00:00', metadata: { position: 'Amend', count: 3, billIds: [] } })
    expect(userEventIcon('position_set', { position: 'Amend' })).toMatchObject({ name: bulk.iconName, color: bulk.iconColor, fill: bulk.iconFill })
  })
})
