import { describe, it, expect } from 'vitest'
import { groupingLineText } from './groupingLine'

// The line a comment thread shows where a bill's companion group formed or
// split. Timestamps are the database's UTC format, at midday so the date is
// the same in any test runner's time zone.
const at = '2026-10-11 12:00:00'
const bill = (billNumber: string) => ({ billId: billNumber.toLowerCase(), billNumber })

describe('groupingLineText', () => {
  it('describes an automatic grouping with one other bill', () => {
    expect(groupingLineText({ id: 'e', type: 'grouped', createdAt: at, actorName: null, with: [bill('S1713')] }))
      .toBe('Grouped with S1713 as identical bills on October 11. Earlier comments from both now appear together.')
  })

  it('describes a grouping with several other bills', () => {
    expect(groupingLineText({ id: 'e', type: 'grouped', createdAt: at, actorName: null, with: [bill('A190'), bill('S1713')] }))
      .toBe('Grouped with A190 and S1713 as identical bills on October 11. Earlier comments from all of them now appear together.')
  })

  it('names the admin who grouped the bills by hand', () => {
    expect(groupingLineText({ id: 'e', type: 'grouped', createdAt: at, actorName: 'Ada', with: [bill('S1713')] }))
      .toBe('Ada grouped this bill with S1713 on October 11. Earlier comments from both now appear together.')
  })

  it('describes a split', () => {
    expect(groupingLineText({ id: 'e', type: 'split', createdAt: '2026-10-12 12:00:00', actorName: null, with: [bill('S1713')] }))
      .toBe('Separated from S1713 on October 12. Comments posted on S1713 no longer appear here.')
  })

  it('lists three or more bills with a serial comma', () => {
    expect(groupingLineText({ id: 'e', type: 'split', createdAt: at, actorName: null, with: [bill('A1'), bill('A2'), bill('A3')] }))
      .toBe('Separated from A1, A2, and A3 on October 11. Comments posted on them no longer appear here.')
  })
})
