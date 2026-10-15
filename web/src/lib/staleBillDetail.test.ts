import { describe, it, expect } from 'vitest'
import { isBillDetailStale } from './staleBillDetail'

const history = [
  { date: '2026-05-14', action: 'Read first time' },
  { date: '2026-05-15', action: 'Referred to Committee on Widgets' },
]

describe('isBillDetailStale', () => {
  it('is stale when the last action is newer than the whole history and not in it', () => {
    expect(isBillDetailStale(history, 'Referred to Committee of the Whole', '2026-09-01')).toBe(true)
  })

  it('does not special-case the text of the last action', () => {
    expect(isBillDetailStale(history, 'Read third time', '2026-09-01')).toBe(true)
    expect(isBillDetailStale(history, 'Referred to Committee on Gadgets', '2026-09-01')).toBe(true)
  })

  it('is current when there is no last action', () => {
    expect(isBillDetailStale(history, null, null)).toBe(false)
    expect(isBillDetailStale(history, null, '2026-09-01')).toBe(false)
    expect(isBillDetailStale(history, '', '2026-09-01')).toBe(false)
  })

  it('is current when there is a last action but no last action date', () => {
    expect(isBillDetailStale(history, 'Read third time', null)).toBe(false)
  })

  it('is current when the last action matches the newest history entry', () => {
    expect(isBillDetailStale(history, 'Referred to Committee on Widgets', '2026-05-15')).toBe(false)
  })

  it('is current when the last action matches the newest entry despite an embedded date prefix', () => {
    expect(isBillDetailStale(history, '05/15/2026 Referred to Committee on Widgets', '2026-05-15')).toBe(false)
  })

  it('is current when the last action is an older history entry', () => {
    expect(isBillDetailStale(history, 'Read first time', '2026-05-14')).toBe(false)
  })

  it('is current when the last action is older than the newest history entry', () => {
    expect(isBillDetailStale(history, 'Something not in history', '2026-05-13')).toBe(false)
  })

  // Pinned to what LegislativeHistory does today: a same-date action whose text differs from
  // every history entry is treated as missing from the history, so it prepends it and flags a gap.
  it('is stale for a same-date last action whose text differs from the history', () => {
    expect(isBillDetailStale(history, 'Amended in committee', '2026-05-15')).toBe(true)
  })

  // Pinned to LegislativeHistory's gap notice, which only shows when there is real history
  // to gap against. An empty history means the detail was never fetched, not that it is behind.
  it('is current when the history is empty', () => {
    expect(isBillDetailStale([], 'Introduced', '2026-04-17')).toBe(false)
  })
})
