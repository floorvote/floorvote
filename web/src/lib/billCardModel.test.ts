import { describe, it, expect } from 'vitest'
import { buildBillCardModel, buildActivityRowModel } from './billCardModel'
import { PRIORITY_COLORS } from './chipStyles'
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
      userId: 'user-1', userName: 'Will', userSubtitle: null, metadata: {}, createdAt: '2026-06-03T10:00:00Z', ...e,
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
    userId: 'user-1', userName: 'Ada Admin', userSubtitle: null,
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
