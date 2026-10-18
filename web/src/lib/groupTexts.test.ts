import { describe, it, expect } from 'vitest'
import { orderGroupTexts } from './groupTexts'
import type { GroupBillTexts, GroupTextVersion } from '../../../shared/companionGroups'

// The Bill texts list shows a group's bills as rows (#712). The order is a
// function of the data alone, so the same on every page in the group.

const v = (docId: string, date: string, type = 'Introduced'): GroupTextVersion => ({ docId, type, date, mime: 'text/html', stateLink: null, altStateLink: null })
const row = (billId: string, billNumber: string, texts: GroupTextVersion[]): GroupBillTexts => ({ billId, billNumber, state: 'RI', sessionSlug: '2026', texts })
const numbers = (rows: GroupBillTexts[]) => rows.map(r => r.billNumber)
const docs = (r: GroupBillTexts) => r.texts.map(t => t.docId)

describe('orderGroupTexts', () => {
  it('orders the rows by each bill\'s newest version, newest first', () => {
    const rows = [
      row('s', 'S282', [v('s2', '2026-06-29'), v('s1', '2026-01-13')]),
      row('a', 'A1715', [v('a3', '2026-10-15'), v('a1', '2026-01-13')]),
    ]
    expect(numbers(orderGroupTexts(rows))).toEqual(['A1715', 'S282'])
  })

  it('orders by the newest version, not the first listed', () => {
    const rows = [
      row('a', 'A1', [v('a1', '2026-01-01'), v('a2', '2026-12-01')]),
      row('s', 'S1', [v('s1', '2026-06-01')]),
    ]
    expect(numbers(orderGroupTexts(rows))).toEqual(['A1', 'S1'])
  })

  it('puts each row\'s versions newest first, whatever order they came in', () => {
    const out = orderGroupTexts([row('a', 'A1', [v('a1', '2026-01-01'), v('a3', '2026-03-01'), v('a2', '2026-02-01')])])
    expect(docs(out[0])).toEqual(['a3', 'a2', 'a1'])
  })

  it('breaks a tie between bills by bill number, so every page agrees', () => {
    const a = row('a', 'A1715', [v('a1', '2026-01-13')])
    const s = row('s', 'S282', [v('s1', '2026-01-13')])
    expect(numbers(orderGroupTexts([s, a]))).toEqual(['A1715', 'S282'])
    expect(numbers(orderGroupTexts([a, s]))).toEqual(['A1715', 'S282'])
  })

  it('breaks a tie between versions of one bill the same way every time', () => {
    const one = orderGroupTexts([row('a', 'A1', [v('a1', '2026-01-01'), v('a2', '2026-01-01')])])
    const two = orderGroupTexts([row('a', 'A1', [v('a2', '2026-01-01'), v('a1', '2026-01-01')])])
    expect(docs(one[0])).toEqual(docs(two[0]))
  })

  it('gives one order for a group of three, from any starting order', () => {
    const a = row('a', 'A1', [v('a1', '2026-03-01')])
    const s = row('s', 'S1', [v('s1', '2026-05-01')])
    const h = row('h', 'H1', [v('h1', '2026-04-01')])
    for (const input of [[a, s, h], [h, s, a], [s, a, h]]) expect(numbers(orderGroupTexts(input))).toEqual(['S1', 'H1', 'A1'])
  })

  it('leaves out a bill with no versions', () => {
    const out = orderGroupTexts([row('a', 'A1', []), row('s', 'S1', [v('s1', '2026-01-01')])])
    expect(numbers(out)).toEqual(['S1'])
  })

  it('does not change what it was given', () => {
    const rows = [row('s', 'S1', [v('s1', '2026-01-01'), v('s2', '2026-02-01')]), row('a', 'A1', [v('a1', '2026-09-01')])]
    const before = JSON.stringify(rows)
    orderGroupTexts(rows)
    expect(JSON.stringify(rows)).toBe(before)
  })

  it('is empty for no rows', () => {
    expect(orderGroupTexts([])).toEqual([])
  })
})
