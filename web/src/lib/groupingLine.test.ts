import { describe, it, expect } from 'vitest'
import type { GroupingEvent } from '../../../shared/companionGroups'
import { groupingLineText, placeGroupingLines, showsGroupingLine } from './groupingLine'

// The line a comment thread shows where a bill's companion group formed or
// split. Timestamps are the database's UTC format, at midday so the date is
// the same in any test runner's time zone.
const at = '2026-10-11 12:00:00'
const bill = (billNumber: string) => ({ billId: billNumber.toLowerCase(), billNumber })
const pair = (a: string, b: string) => [bill(a), bill(b)] as [ReturnType<typeof bill>, ReturnType<typeof bill>]
const event = (over: Partial<GroupingEvent>): GroupingEvent =>
  ({ id: 'e', type: 'grouped', createdAt: at, actorName: null, with: [bill('A190')], commentBills: [], replaced: [], ...over })

describe('groupingLineText', () => {
  describe('a grouping FloorVote made', () => {
    it('names the bill whose earlier comments now appear', () => {
      expect(groupingLineText(event({ with: [bill('A190')], commentBills: [bill('A190')] })))
        .toBe('Grouped with A190 as identical bills on October 11. Earlier comments on A190 now appear here.')
    })

    it('names only the bills with earlier comments among several it grouped with', () => {
      expect(groupingLineText(event({ with: [bill('A190'), bill('S1713')], commentBills: [bill('S1713')] })))
        .toBe('Grouped with A190 and S1713 as identical bills on October 11. Earlier comments on S1713 now appear here.')
    })

    it('lists several bills with earlier comments, with a serial comma', () => {
      expect(groupingLineText(event({ with: [bill('A190'), bill('S1713')], commentBills: [bill('A190'), bill('S1713')] })))
        .toBe('Grouped with A190 and S1713 as identical bills on October 11. Earlier comments on A190 and S1713 now appear here.')
      expect(groupingLineText(event({ with: [bill('A1'), bill('A2'), bill('A3')], commentBills: [bill('A1'), bill('A2'), bill('A3')] })))
        .toBe('Grouped with A1, A2, and A3 as identical bills on October 11. Earlier comments on A1, A2, and A3 now appear here.')
    })

    it('says nothing of comments when none came before it, so the replaced-value sentence stands alone', () => {
      const replaced = [{ field: 'position' as const, label: 'position', billId: 's1713', billNumber: 'S1713', value: 'Oppose', replacedBy: { billId: 'a190', billNumber: 'A190', value: 'Support' } }]
      expect(groupingLineText(event({ with: [bill('S1713')], replaced })))
        .toBe("Grouped with S1713 as identical bills on October 11. S1713's position, Oppose, was replaced by A190's, Support.")
    })

    it('puts the replaced-value sentence after the comments sentence', () => {
      const replaced = [{ field: 'position' as const, label: 'position', billId: 's1713', billNumber: 'S1713', value: 'Oppose', replacedBy: { billId: 'a190', billNumber: 'A190', value: 'Support' } }]
      expect(groupingLineText(event({ with: [bill('S1713')], commentBills: [bill('S1713')], replaced })))
        .toBe("Grouped with S1713 as identical bills on October 11. Earlier comments on S1713 now appear here. S1713's position, Oppose, was replaced by A190's, Support.")
    })

    it('lists each replaced value, custom fields by name', () => {
      const replaced = [
        { field: 'priority' as const, label: 'priority', billId: 'a190', billNumber: 'A190', value: 'Low', replacedBy: { billId: 's1713', billNumber: 'S1713', value: 'High' } },
        { field: 'customField' as const, fieldId: 'cf1', label: 'Committee', billId: 'a190', billNumber: 'A190', value: 'Energy', replacedBy: { billId: 's1713', billNumber: 'S1713', value: 'Labor' } },
      ]
      expect(groupingLineText(event({ with: [bill('S1713')], replaced })))
        .toBe("Grouped with S1713 as identical bills on October 11. A190's priority, Low, was replaced by S1713's, High. A190's Committee, Energy, was replaced by S1713's, Labor.")
    })

    it('says which splits it undid, without a comments sentence when no comments came before it', () => {
      expect(groupingLineText(event({ with: [bill('A190')], undoneSplits: [pair('A190', 'H3000')] })))
        .toBe('Grouped with A190 as identical bills on October 11. It undid the split of A190 and H3000.')
    })
  })

  describe('a grouping an admin made by hand', () => {
    it('names the admin and the bill whose earlier comments now appear', () => {
      expect(groupingLineText(event({ actorName: 'Ada', with: [bill('S1713')], commentBills: [bill('S1713')] })))
        .toBe('Ada grouped this bill with S1713 on October 11. Earlier comments on S1713 now appear here.')
    })

    it('still names the admin, without a comments sentence, when no comments came before it', () => {
      expect(groupingLineText(event({ actorName: 'Ada', with: [bill('S1713')] })))
        .toBe('Ada grouped this bill with S1713 on October 11.')
    })

    it('says which splits grouping by hand undid, so the page keeps what the admin was told', () => {
      expect(groupingLineText(event({ actorName: 'Ada', with: [bill('A190')], commentBills: [bill('A190')], undoneSplits: [pair('A190', 'H3000')] })))
        .toBe('Ada grouped this bill with A190 on October 11. Earlier comments on A190 now appear here. It undid the split of A190 and H3000.')
      expect(groupingLineText(event({ actorName: 'Ada', with: [bill('A190')], commentBills: [bill('A190')], undoneSplits: [pair('A190', 'H3000'), pair('H3000', 'S1713')] })))
        .toBe('Ada grouped this bill with A190 on October 11. Earlier comments on A190 now appear here. It undid the splits of A190 and H3000, and H3000 and S1713.')
    })

    it('says nothing of splits for a grouping that undid none, or an older event with no record of them', () => {
      expect(groupingLineText(event({ actorName: 'Ada', with: [bill('A190')], commentBills: [bill('A190')], undoneSplits: [] })))
        .toBe('Ada grouped this bill with A190 on October 11. Earlier comments on A190 now appear here.')
    })

    it('says which splits it undid when no comments came before it', () => {
      expect(groupingLineText(event({ actorName: 'Ada', with: [bill('A190')], undoneSplits: [pair('A190', 'H3000')] })))
        .toBe('Ada grouped this bill with A190 on October 11. It undid the split of A190 and H3000.')
    })
  })

  describe('a split FloorVote made', () => {
    it('says comments posted on the bill that left no longer appear', () => {
      expect(groupingLineText(event({ type: 'split', createdAt: '2026-10-12 12:00:00', with: [bill('A190')], commentBills: [bill('A190')] })))
        .toBe('Separated from A190 on October 12. Comments posted on A190 no longer appear here.')
    })

    it('names only the bills that left with comments, among several', () => {
      expect(groupingLineText(event({ type: 'split', with: [bill('A1'), bill('A2'), bill('A3')], commentBills: [bill('A2')] })))
        .toBe('Separated from A1, A2, and A3 on October 11. Comments posted on A2 no longer appear here.')
      expect(groupingLineText(event({ type: 'split', with: [bill('A1'), bill('A2'), bill('A3')], commentBills: [bill('A1'), bill('A3')] })))
        .toBe('Separated from A1, A2, and A3 on October 11. Comments posted on A1 and A3 no longer appear here.')
    })
  })

  describe('a split an admin made by hand', () => {
    it('names the admin and the bill whose comments no longer appear', () => {
      expect(groupingLineText(event({ type: 'split', actorName: 'Ada', createdAt: '2026-10-12 12:00:00', with: [bill('S1713')], commentBills: [bill('S1713')] })))
        .toBe('Ada separated this bill from S1713 on October 12. Comments posted on S1713 no longer appear here.')
    })

    it('still names the admin, without a comments sentence, when the bill had no earlier comments', () => {
      expect(groupingLineText(event({ type: 'split', actorName: 'Ada', createdAt: '2026-10-12 12:00:00', with: [bill('S1713')] })))
        .toBe('Ada separated this bill from S1713 on October 12.')
    })
  })
})

describe('showsGroupingLine', () => {
  it('hides an automatic grouping that explains nothing: no earlier comments, nothing replaced, no undone splits', () => {
    expect(showsGroupingLine(event({}))).toBe(false)
    expect(showsGroupingLine(event({ undoneSplits: [] }))).toBe(false)
  })

  it('hides an automatic split with no comments on the bill that left', () => {
    expect(showsGroupingLine(event({ type: 'split' }))).toBe(false)
  })

  it('shows an automatic grouping or split with earlier comments on a bill it joined or left', () => {
    expect(showsGroupingLine(event({ commentBills: [bill('A190')] }))).toBe(true)
    expect(showsGroupingLine(event({ type: 'split', commentBills: [bill('A190')] }))).toBe(true)
  })

  it('shows an automatic grouping that replaced a team value, with no comments', () => {
    const replaced = [{ field: 'position' as const, label: 'position', billId: 's1713', billNumber: 'S1713', value: 'Oppose', replacedBy: { billId: 'a190', billNumber: 'A190', value: 'Support' } }]
    expect(showsGroupingLine(event({ replaced }))).toBe(true)
  })

  it('shows an automatic grouping that undid splits, with no comments', () => {
    expect(showsGroupingLine(event({ undoneSplits: [pair('A190', 'H3000')] }))).toBe(true)
  })

  it('always shows a grouping or split an admin made by hand', () => {
    expect(showsGroupingLine(event({ actorName: 'Ada' }))).toBe(true)
    expect(showsGroupingLine(event({ type: 'split', actorName: 'Ada' }))).toBe(true)
  })

  it('treats an event from a server that sends no commentBills as having none', () => {
    const old = event({}) as Partial<GroupingEvent>
    delete old.commentBills
    expect(showsGroupingLine(old as GroupingEvent)).toBe(false)
  })
})

describe('placeGroupingLines', () => {
  const comments = [{ id: 'c1', createdAt: '2026-10-10 12:00:00' }, { id: 'c2', createdAt: '2026-10-12 12:00:00' }]

  it('places a line that shows before the first comment posted after it', () => {
    const e = event({ id: 'g', commentBills: [bill('A190')] })
    const placed = placeGroupingLines(comments, [e])
    expect(placed.before.get('c2')).toEqual([e])
    expect(placed.after).toEqual([])
  })

  it('places a line after every comment when none came later, even in an empty thread', () => {
    const e = event({ id: 'g', commentBills: [bill('A190')] })
    expect(placeGroupingLines([], [e]).after).toEqual([e])
  })

  it('leaves a line that would show nothing out of the thread, whether or not comments exist', () => {
    const hidden = event({ id: 'g' })
    expect(placeGroupingLines([], [hidden])).toEqual({ before: new Map(), after: [] })
    expect(placeGroupingLines(comments, [hidden])).toEqual({ before: new Map(), after: [] })
  })

  it('keeps the lines that show when a hidden one sits between them', () => {
    const shown = event({ id: 'g1', commentBills: [bill('A190')] })
    const hidden = event({ id: 'g2', type: 'split', createdAt: '2026-10-11 13:00:00' })
    const last = event({ id: 'g3', type: 'split', actorName: 'Ada', createdAt: '2026-10-13 12:00:00' })
    const placed = placeGroupingLines(comments, [shown, hidden, last])
    expect(placed.before.get('c2')).toEqual([shown])
    expect(placed.after).toEqual([last])
  })

  it('puts a comment posted at the very second of an event above its line, as the server counts it before the event', () => {
    const e = event({ id: 'g', createdAt: '2026-10-10 12:00:00', commentBills: [bill('A190')] })
    expect(placeGroupingLines(comments, [e]).before.get('c2')).toEqual([e])
  })
})
