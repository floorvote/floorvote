import { describe, it, expect } from 'vitest'
import { billsApiParams, billsFilterValuesFromSearch, billsChipSelection, prioritizedChipSelection } from './billsQuery'

describe('billsApiParams', () => {
  it('emits params in the canonical order matching fetchBills', () => {
    const v = billsFilterValuesFromSearch(new URLSearchParams('status=2&priority=high&newMatches=1&tag=elections'))
    const s = billsApiParams(v, 1, 100)
    expect(s).toBe('page=1&pageSize=100&status=2&priority=high&newMatches=1&tag=elections')
  })

  it('parses a bare /bills URL to an empty (page-1) query', () => {
    const v = billsFilterValuesFromSearch(new URLSearchParams(''))
    expect(billsApiParams(v, 1, 100)).toBe('page=1&pageSize=100')
  })

  it('round-trips sort/dir and minRelevance', () => {
    const v = billsFilterValuesFromSearch(new URLSearchParams('sort=relevance&dir=desc&minRelevance=5'))
    expect(billsApiParams(v, 1, 100)).toBe('page=1&pageSize=100&minRelevance=5&sort=relevance&dir=desc')
  })
})

describe('billsChipSelection', () => {
  it('selects the all-bills chip on the unfiltered /bills view', () => {
    expect(billsChipSelection('/bills', '')).toEqual({ allBills: true, newMatches: false })
  })

  it('selects the new-matches chip when newMatches is the only active filter', () => {
    expect(billsChipSelection('/bills', '?newMatches=1')).toEqual({ allBills: false, newMatches: true })
  })

  it('selects neither chip when any other filter is active', () => {
    expect(billsChipSelection('/bills', '?status=2')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?myBills=1')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?priority=high')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?tag=elections')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?minRelevance=5')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills', '?cf_42=foo')).toEqual({ allBills: false, newMatches: false })
  })

  it('deselects the new-matches chip when another filter joins newMatches', () => {
    expect(billsChipSelection('/bills', '?newMatches=1&status=2')).toEqual({ allBills: false, newMatches: false })
  })

  it('ignores sort/dir — a sort is not a filter', () => {
    expect(billsChipSelection('/bills', '?sort=relevance&dir=desc')).toEqual({ allBills: true, newMatches: false })
    expect(billsChipSelection('/bills', '?newMatches=1&sort=relevance')).toEqual({ allBills: false, newMatches: true })
  })

  it('selects neither chip away from the bills list (other pages, bill detail)', () => {
    expect(billsChipSelection('/feed', '')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/bills/HB123', '')).toEqual({ allBills: false, newMatches: false })
    expect(billsChipSelection('/calendar', '?newMatches=1')).toEqual({ allBills: false, newMatches: false })
  })
})

describe('prioritizedChipSelection', () => {
  const PRIORITY_QS = '?priority=high&priority=medium&priority=low'

  it('selects the priority chip when the filter is exactly the three priority tiers', () => {
    expect(prioritizedChipSelection('/bills', PRIORITY_QS)).toEqual({ priority: true, unvoted: false })
  })

  it('selects the unvoted chip when unvoted=1 joins the same priority filter', () => {
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&unvoted=1`)).toEqual({ priority: false, unvoted: true })
  })

  it('is order-independent for the priority tiers', () => {
    expect(prioritizedChipSelection('/bills', '?priority=low&priority=high&priority=medium')).toEqual({ priority: true, unvoted: false })
  })

  it('selects neither chip when the priority filter is incomplete or has an extra value', () => {
    expect(prioritizedChipSelection('/bills', '?priority=high&priority=medium')).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', '?priority=high')).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', '')).toEqual({ priority: false, unvoted: false })
  })

  it('selects neither chip when any other filter joins the priority filter', () => {
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&status=2`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&myBills=1`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&newMatches=1`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&tag=elections`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&minRelevance=5`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&cf_42=foo`)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&unvoted=1&status=2`)).toEqual({ priority: false, unvoted: false })
  })

  it('ignores sort/dir — a sort is not a filter', () => {
    expect(prioritizedChipSelection('/bills', `${PRIORITY_QS}&sort=relevance&dir=desc`)).toEqual({ priority: true, unvoted: false })
  })

  it('selects neither chip away from the bills list (other pages, bill detail)', () => {
    expect(prioritizedChipSelection('/feed', PRIORITY_QS)).toEqual({ priority: false, unvoted: false })
    expect(prioritizedChipSelection('/bills/HB123', PRIORITY_QS)).toEqual({ priority: false, unvoted: false })
  })
})
