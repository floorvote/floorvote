import { describe, it, expect } from 'vitest'
import { groupingLineText } from './groupingLine'

// The line a comment thread shows where a bill's companion group formed or
// split. Timestamps are the database's UTC format, at midday so the date is
// the same in any test runner's time zone.
const at = '2026-10-11 12:00:00'
const bill = (billNumber: string) => ({ billId: billNumber.toLowerCase(), billNumber })

describe('groupingLineText', () => {
  it('describes an automatic grouping with one other bill', () => {
    expect(groupingLineText({ id: 'e', type: 'grouped', createdAt: at, actorName: null, with: [bill('S1713')], replaced: [] }))
      .toBe('Grouped with S1713 as identical bills on October 11. Earlier comments from both now appear together.')
  })

  it('describes a grouping with several other bills', () => {
    expect(groupingLineText({ id: 'e', type: 'grouped', createdAt: at, actorName: null, with: [bill('A190'), bill('S1713')], replaced: [] }))
      .toBe('Grouped with A190 and S1713 as identical bills on October 11. Earlier comments from all of them now appear together.')
  })

  it('names the admin who grouped the bills by hand', () => {
    expect(groupingLineText({ id: 'e', type: 'grouped', createdAt: at, actorName: 'Ada', with: [bill('S1713')], replaced: [] }))
      .toBe('Ada grouped this bill with S1713 on October 11. Earlier comments from both now appear together.')
  })

  it('describes a split', () => {
    expect(groupingLineText({ id: 'e', type: 'split', createdAt: '2026-10-12 12:00:00', actorName: null, with: [bill('S1713')], replaced: [] }))
      .toBe('Separated from S1713 on October 12. Comments posted on S1713 no longer appear here.')
  })

  it('lists a team field value the grouping replaced', () => {
    const replaced = [{ field: 'position' as const, label: 'position', billId: 's1713', billNumber: 'S1713', value: 'Oppose', replacedBy: { billId: 'a190', billNumber: 'A190', value: 'Support' } }]
    expect(groupingLineText({ id: 'e', type: 'grouped', createdAt: at, actorName: null, with: [bill('S1713')], replaced }))
      .toBe("Grouped with S1713 as identical bills on October 11. Earlier comments from both now appear together. S1713's position, Oppose, was replaced by A190's, Support.")
  })

  it('lists each replaced value, custom fields by name', () => {
    const replaced = [
      { field: 'priority' as const, label: 'priority', billId: 'a190', billNumber: 'A190', value: 'Low', replacedBy: { billId: 's1713', billNumber: 'S1713', value: 'High' } },
      { field: 'customField' as const, fieldId: 'cf1', label: 'Committee', billId: 'a190', billNumber: 'A190', value: 'Energy', replacedBy: { billId: 's1713', billNumber: 'S1713', value: 'Labor' } },
    ]
    expect(groupingLineText({ id: 'e', type: 'grouped', createdAt: at, actorName: 'Ada', with: [bill('S1713')], replaced }))
      .toBe("Ada grouped this bill with S1713 on October 11. Earlier comments from both now appear together. A190's priority, Low, was replaced by S1713's, High. A190's Committee, Energy, was replaced by S1713's, Labor.")
  })

  it('lists three or more bills with a serial comma', () => {
    expect(groupingLineText({ id: 'e', type: 'split', createdAt: at, actorName: null, with: [bill('A1'), bill('A2'), bill('A3')], replaced: [] }))
      .toBe('Separated from A1, A2, and A3 on October 11. Comments posted on them no longer appear here.')
  })
})
