// One list of active filters, read by every surface. For every filter, set alone and all together, the badge
// (the count of values), Reset, the chips on the page and in the filter sheet, and the split pane's summary
// must agree, because each reads the one list from the shared module and none counts for itself.

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, render, screen, within, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom'
import type { ReactNode, ComponentProps } from 'react'
import { useBillFilters } from '../../hooks/useBillFilters'
import { FilterSheet } from '../../components/FilterSheet'
import { buildListSummary } from './listSummary'
import { billsQueryFromSearch } from './billsQuery'
import { buildActiveFilterGroups } from './activeFilterGroups'
import { chipFilters } from '../../lib/filterDimensions'
import { activeFilterCount, activeFilters } from '../../../../shared/billFilter'
import type { CustomFieldDef, FacetCounts } from './types'

const facets: FacetCounts = { status: {}, stage: {}, priority: {}, sessionName: {}, year: {}, state: {}, position: {}, tag: {}, subject: {}, field: {}, myBillsCount: 0, newMatchesCount: 0, unvotedCount: 0, draftCount: 0, hasDrafts: true }

const TEAM: CustomFieldDef = { id: 'cf-team', name: 'Team', slug: 'team', type: 'dropdown', options: ['Alpha', 'Beta'], displayOrder: 0 }
const FLAG: CustomFieldDef = { id: 'cf-flag', name: 'Flagged', slug: 'flagged', type: 'binary', options: null, displayOrder: 1 }
const DEFS = [TEAM, FLAG]

// One query per filter, each with the number of values it adds to the badge, and whether it draws chips.
const SINGLES: { name: string; qs: string; badge: number; chips: number }[] = [
  { name: 'status', qs: 'status=2&status=3', badge: 2, chips: 2 },
  { name: 'stage', qs: 'stage=introduced', badge: 1, chips: 1 },
  { name: 'year', qs: 'year=2026&year=2025', badge: 2, chips: 2 },
  { name: 'state', qs: 'state=UT', badge: 1, chips: 1 },
  { name: 'position', qs: 'position=Support&position=none', badge: 2, chips: 2 },
  { name: 'priority', qs: 'priority=high', badge: 1, chips: 1 },
  { name: 'tag', qs: 'tag=Water&tag=Roads', badge: 2, chips: 2 },
  { name: 'subject', qs: 'subject=UT%3AElections', badge: 1, chips: 1 },
  { name: 'minRelevance', qs: 'minRelevance=4', badge: 1, chips: 1 },
  { name: 'myBills', qs: 'myBills=1', badge: 1, chips: 0 },
  { name: 'unvoted', qs: 'unvoted=1', badge: 1, chips: 0 },
  { name: 'newMatches', qs: 'newMatches=1', badge: 1, chips: 0 },
  { name: 'drafts', qs: 'drafts=1', badge: 1, chips: 0 },
  { name: 'custom dropdown field', qs: 'field.team=Alpha&field.team=Beta', badge: 2, chips: 2 },
  { name: 'custom binary field', qs: 'field.flagged=true', badge: 1, chips: 1 },
]
const EVERYTHING = SINGLES.filter(s => s.name !== 'custom binary field').map(s => s.qs).join('&')
const EVERYTHING_BADGE = SINGLES.filter(s => s.name !== 'custom binary field').reduce((n, s) => n + s.badge, 0)
const EVERYTHING_CHIPS = SINGLES.filter(s => s.name !== 'custom binary field').reduce((n, s) => n + s.chips, 0)

function useHarness() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  return useBillFilters({
    searchParams, setSearchParams, location, facetCounts: facets, customFieldDefs: DEFS, positionVocabulary: ['Support'], tagTaxonomy: [],
    sortCol: 'default', sortDir: 'asc', setSortCol: () => {}, setSortDir: () => {},
  })
}
const hookAt = (qs: string) => renderHook(useHarness, {
  wrapper: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[`/bills?${qs}`]}>{children}</MemoryRouter>,
})

type F = ReturnType<typeof useHarness>

function sheetFor(f: F, over: Partial<ComponentProps<typeof FilterSheet>> = {}) {
  const noop = vi.fn()
  return render(
    <FilterSheet
      isOpen onClose={noop} status={f.status} stage={f.stage} priority={f.priority} position={f.position} tag={f.tag} subject={f.subject}
      year={f.year.map(String)} minRelevance={f.minRelevance} myBills={f.myBills} state={f.state} isAdmin newMatches={f.newMatches}
      newMatchesCount={0} unvoted={f.unvoted} drafts={f.drafts} draftCount={0} hasDrafts match={f.match} onMatchChange={noop}
      uniqueStates={['UT']} isMultiState={false} statusOptions={[]} stageOptions={[]} priorityOptions={[]} positionOptions={[{ value: 'Support', label: 'Support' }]}
      tagOptions={[]} subjectGroups={[]} yearOptions={[]} stateOptions={[]} customFieldDefs={DEFS} field={f.field} onFieldChange={noop}
      onStatusChange={noop} onStageChange={noop} onPriorityChange={noop} onPositionChange={noop} onTagChange={noop} onSubjectChange={noop}
      onYearChange={noop} onStateChange={noop} onMinRelevanceChange={noop} onMyBillsChange={noop} onNewMatchesChange={noop}
      onUnvotedChange={noop} onDraftsChange={noop} onClearAll={noop} search={f.search}
      {...over}
    />,
  )
}
const sheetChipCount = () => {
  const row = screen.queryByTestId('sheet-active-filter-chips')
  return row ? within(row).getAllByRole('button', { name: '×' }).length : 0
}
const hasReset = () => screen.queryByRole('button', { name: 'Reset filters' }) !== null

function pageChipCount(f: F): number {
  const groups = buildActiveFilterGroups({
    state: f.state, status: f.status, stage: f.stage, position: f.position, priority: f.priority, year: f.year, tag: f.tag, subject: f.subject,
    field: f.field, minRelevance: f.minRelevance, positionOptions: f.positionOptions, customFieldDefs: DEFS, isMultiState: false,
    active: f.activeFilters,
    onRemoveState: vi.fn(), onRemoveStatus: vi.fn(), onRemoveStage: vi.fn(), onRemovePosition: vi.fn(), onRemovePriority: vi.fn(),
    onRemoveYear: vi.fn(), onRemoveTag: vi.fn(), onRemoveSubject: vi.fn(), onRemoveField: vi.fn(), onRemoveMinRelevance: vi.fn(),
  })
  return groups.reduce((n, g) => n + g.chips.length, 0)
}

const summaryOf = (qs: string, search = '') => {
  const q = billsQueryFromSearch(new URLSearchParams(qs), DEFS)
  return buildListSummary({ values: { ...q, filter: { ...q.filter, search } }, customFieldDefs: DEFS })
}

describe('one list of active filters: every surface agrees, filter by filter', () => {
  it.each(SINGLES)('$name: the badge, Reset, the chips, the sheet, and the summary agree', ({ qs, badge, chips }) => {
    const { result } = hookAt(qs)
    const f = result.current
    // The hook's list is the shared list for its own value.
    expect(f.activeFilters).toEqual(activeFilters(f.filter))
    expect(f.totalActiveFilters).toBe(badge)
    expect(f.totalActiveFilters).toBe(activeFilterCount(f.activeFilters))
    expect(f.hasActiveFilters).toBe(true)
    // The split pane's summary lists the same values.
    const summary = summaryOf(qs)
    expect(summary.filterCount).toBe(badge)
    expect(summary.filters).toHaveLength(badge)
    // The page's chip row and the sheet's chip row draw the same chips, the ones that are not their own pill.
    expect(pageChipCount(f)).toBe(chips)
    expect(chipFilters(f.activeFilters).reduce((n, a) => n + a.count, 0)).toBe(chips)
    sheetFor(f)
    expect(sheetChipCount()).toBe(chips)
    expect(hasReset()).toBe(true)
    cleanup()
  })

  it('every filter set: the badge, the sheet, and the summary agree, search and the match mode aside', () => {
    const { result } = hookAt(`${EVERYTHING}&match=any`)
    act(() => result.current.setSearch('storm'))
    const f = result.current
    expect(f.totalActiveFilters).toBe(EVERYTHING_BADGE)
    expect(f.activeFilters.map(a => a.name)).toContain('search')
    expect(f.activeFilters.map(a => a.name)).not.toContain('match')
    // The summary counts the search term as one more entry than the badge does.
    const summary = summaryOf(`${EVERYTHING}&match=any`, 'storm')
    expect(summary.filterCount).toBe(EVERYTHING_BADGE + 1)
    expect(summary.filters[0]).toBe('Search: “storm”')
    expect(pageChipCount(f)).toBe(EVERYTHING_CHIPS)
    sheetFor(f)
    expect(sheetChipCount()).toBe(EVERYTHING_CHIPS)
    expect(hasReset()).toBe(true)
    cleanup()
  })

  it('search alone: Reset and the summary entry show, and the badge stays at zero', () => {
    const { result } = hookAt('')
    act(() => result.current.setSearch('storm'))
    const f = result.current
    expect(f.hasActiveFilters).toBe(true)
    expect(f.totalActiveFilters).toBe(0)
    expect(f.activeFilters).toEqual([{ name: 'search', key: 'search', count: 1 }])
    const summary = summaryOf('', 'storm')
    expect(summary.filters).toEqual(['Search: “storm”'])
    expect(summary.filterCount).toBe(1)
    sheetFor(f)
    expect(hasReset()).toBe(true)
    expect(sheetChipCount()).toBe(0)
    cleanup()
  })

  it('the match mode alone is not a filter: no Reset, no badge, no summary entry', () => {
    const { result } = hookAt('match=any')
    const f = result.current
    expect(f.activeFilters).toEqual([])
    expect(f.hasActiveFilters).toBe(false)
    expect(f.totalActiveFilters).toBe(0)
    expect(summaryOf('match=any').filters).toEqual([])
    sheetFor(f)
    expect(hasReset()).toBe(false)
    cleanup()
  })

  it('nothing set: every surface is empty', () => {
    const { result } = hookAt('')
    const f = result.current
    expect(f.activeFilters).toEqual([])
    expect(f.hasActiveFilters).toBe(false)
    expect(f.totalActiveFilters).toBe(0)
    expect(summaryOf('').text).toBe('All bills · Sorted by default order')
    sheetFor(f)
    expect(hasReset()).toBe(false)
    cleanup()
  })

  it('a custom-field filter and a toggle each count once', () => {
    const { result } = hookAt('field.flagged=true&unvoted=1')
    expect(result.current.totalActiveFilters).toBe(2)
    expect(summaryOf('field.flagged=true&unvoted=1').filterCount).toBe(2)
  })
})

describe('Reset clears exactly the active list', () => {
  it.each(SINGLES)('$name: after Reset the list is empty, on every surface', ({ qs }) => {
    const { result } = hookAt(qs)
    expect(result.current.activeFilters.length).toBeGreaterThan(0)
    act(() => result.current.handleResetFilters())
    const f = result.current
    expect(f.activeFilters).toEqual([])
    expect(f.hasActiveFilters).toBe(false)
    expect(f.totalActiveFilters).toBe(0)
    sheetFor(f)
    expect(hasReset()).toBe(false)
    cleanup()
  })

  it('clears every filter at once, search and the match mode included', () => {
    const { result } = hookAt(`${EVERYTHING}&match=any`)
    act(() => result.current.setSearch('storm'))
    expect(result.current.activeFilters.length).toBeGreaterThan(10)
    act(() => result.current.handleResetFilters())
    expect(result.current.activeFilters).toEqual([])
    expect(result.current.match).toBe('all')
    expect(result.current.search).toBe('')
  })

  it('a filter removed one at a time leaves the list and the badge in step', () => {
    const { result } = hookAt('status=2&status=3&unvoted=1')
    expect(result.current.totalActiveFilters).toBe(3)
    act(() => result.current.handleStatusClick('2'))
    expect(result.current.totalActiveFilters).toBe(2)
    act(() => result.current.setUnvoted(false))
    expect(result.current.activeFilters).toEqual([{ name: 'status', key: 'status', count: 1 }])
    act(() => result.current.handleStatusClick('3'))
    expect(result.current.activeFilters).toEqual([])
    expect(result.current.hasActiveFilters).toBe(false)
  })
})
