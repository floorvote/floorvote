import { describe, it, expect } from 'vitest'
import {
  CHIP_SELECTION_LEAVES_OUT, FILTER_DIMENSIONS, chipFilters, hiddenFilterDimensions, type FilterDimensionContext,
} from './filterDimensions'
import { BILL_FILTER_DEFS, EMPTY_BILL_FILTER, activeFilters, withBillFilter } from '../../../shared/billFilter'

const ctx = (over: Partial<FilterDimensionContext> = {}): FilterDimensionContext => ({
  uniqueStates: ['UT'], isAdmin: false, isMultiState: false, hasDrafts: false, draftsActive: false, newMatchesActive: false, ...over,
})

// The few real differences between the filters that count and the filters that draw a chip are declared once,
// on the registry, and every surface reads them from here.
describe('registry: which filters have their own pill', () => {
  it('declares the four workflow filters as having their own pill, and no other', () => {
    const own = FILTER_DIMENSIONS.filter(d => (d as { hasOwnPill?: boolean }).hasOwnPill).map(d => d.key).sort()
    expect(own).toEqual(['drafts', 'myBills', 'newMatches', 'unvoted'])
  })

  it('leaves a filter with its own pill out of the chips, and keeps it in the list', () => {
    const f = withBillFilter({ newMatches: true, myBills: true, status: ['2'], search: 'water' })
    const list = activeFilters(f)
    expect(list.map(a => a.name)).toEqual(['status', 'search', 'myBills', 'newMatches'])
    expect(chipFilters(list).map(a => a.name)).toEqual(['status'])
  })

  it('shows New matches as its own pill and no chip', () => {
    const list = activeFilters(withBillFilter({ newMatches: true }))
    expect(list.map(a => a.name)).toEqual(['newMatches'])
    expect(chipFilters(list)).toEqual([])
  })

  it('gives every filter a chip but the ones declared as having their own pill, and the search box, which is its own control', () => {
    const everything = BILL_FILTER_DEFS.map(d => d.name).filter(n => n !== 'match')
    const f = withBillFilter({
      status: ['2'], stage: ['introduced'], year: ['2026'], sessionName: ['x'], state: ['UT'], position: ['Support'], priority: ['high'],
      tag: ['Water'], subject: [{ state: 'UT', name: 'Elections' }], minRelevance: 4, search: 'storm',
      myBills: true, unvoted: true, newMatches: true, drafts: true, field: { team: ['a'] },
    })
    const chips = chipFilters(activeFilters(f)).map(a => a.name)
    expect(chips).toEqual(everything.filter(n => !['myBills', 'unvoted', 'newMatches', 'drafts', 'search'].includes(n)))
  })
})

describe('registry: the filters a chip selection leaves out', () => {
  it('declares what the Bills nav chip leaves out: the new matches it selects, and the search box', () => {
    expect([...CHIP_SELECTION_LEAVES_OUT.billsNav].sort()).toEqual(['newMatches', 'search'])
  })

  it('declares what the prioritized view leaves out: the priority tiers and the not-yet-voted toggle it selects, and the search box', () => {
    expect([...CHIP_SELECTION_LEAVES_OUT.prioritized].sort()).toEqual(['priority', 'search', 'unvoted'])
  })

  it('only names filters the shared module defines, and never the match mode, which is never in the list', () => {
    const names = BILL_FILTER_DEFS.map(d => d.name as string)
    for (const left of Object.values(CHIP_SELECTION_LEAVES_OUT)) {
      for (const name of left) expect(names).toContain(name)
      expect(left).not.toContain('match')
    }
  })
})

describe('registry: filters hidden on an instance', () => {
  it('hides Drafts on an instance with no drafts, and New matches from a member', () => {
    const hidden = hiddenFilterDimensions(ctx({ isAdmin: false, hasDrafts: false }))
    expect(hidden).toContain('drafts')
    expect(hidden).toContain('newMatches')
  })

  it('shows them again once their own filter is on, so an active filter is never hidden', () => {
    const hidden = hiddenFilterDimensions(ctx({ draftsActive: true, newMatchesActive: true }))
    expect(hidden).not.toContain('drafts')
    expect(hidden).not.toContain('newMatches')
  })

  it('hides nothing an admin on a multi-state instance with drafts can see', () => {
    expect(hiddenFilterDimensions(ctx({ isAdmin: true, isMultiState: true, hasDrafts: true, stageUseful: true }))).toEqual([])
  })

  it('keeps counting a state filter on a single-state instance, where its control is hidden but it still narrows the list', () => {
    expect(hiddenFilterDimensions(ctx({ isMultiState: false }))).not.toContain('state')
  })

  it('does not count a hidden filter in the list', () => {
    const f = withBillFilter({ drafts: true, status: ['2'] })
    const hidden = hiddenFilterDimensions(ctx({ draftsActive: false, hasDrafts: false }))
    expect(activeFilters(f, { hidden }).map(a => a.name)).toEqual(['status'])
    expect(activeFilters(EMPTY_BILL_FILTER, { hidden })).toEqual([])
  })
})
