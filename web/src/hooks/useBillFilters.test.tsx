import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useBillFilters } from './useBillFilters'
import type { CustomFieldDef, FacetCounts } from '../pages/BillList/types'

const emptyFacets: FacetCounts = { status: {}, priority: {}, session: {}, year: {}, state: {}, position: {}, tags: {}, subjects: {}, customFields: {}, myBillsCount: 0, newMatchesCount: 0 }

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/bills']}>{children}</MemoryRouter>
}

function subjectWrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/bills?subject=UT%3AElection+Law']}>{children}</MemoryRouter>
}

function useHarness(facetCounts: FacetCounts = emptyFacets, tagTaxonomy: string[] = [], customFieldDefs: CustomFieldDef[] = []) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const filters = useBillFilters({
    searchParams, setSearchParams, location,
    facetCounts, customFieldDefs, positionVocabulary: ['Support'], tagTaxonomy,
    sortCol: 'default', sortDir: 'asc', setSortCol: () => {}, setSortDir: () => {},
  })
  return { ...filters, urlSearch: location.search }
}

describe('useBillFilters', () => {
  it('handleStatusClick toggles a status on then off', () => {
    const { result } = renderHook(useHarness, { wrapper })
    act(() => result.current.handleStatusClick('Introduced'))
    expect(result.current.filterStatuses).toContain('Introduced')
    act(() => result.current.handleStatusClick('Introduced'))
    expect(result.current.filterStatuses).not.toContain('Introduced')
  })

  it('hasActiveFilters reflects an applied filter', () => {
    const { result } = renderHook(useHarness, { wrapper })
    expect(result.current.hasActiveFilters).toBe(false)
    act(() => result.current.setMyBills(true))
    expect(result.current.hasActiveFilters).toBe(true)
  })

  it('allTags excludes the FILTER_ANY sentinel that the facets API returns', () => {
    const facets: FacetCounts = { ...emptyFacets, tags: { elections: 3, voting: 2, __any__: 4 } }
    const { result } = renderHook(() => useHarness(facets), { wrapper })
    expect(result.current.allTags).toEqual(['elections', 'voting'])
    expect(result.current.allTags).not.toContain('__any__')
  })

  it('allTags excludes tags not in the taxonomy', () => {
    const facets: FacetCounts = { ...emptyFacets, tags: { Elections: 3, 'Land Records': 1, __any__: 4 } }
    const { result } = renderHook(() => useHarness(facets, ['Elections']), { wrapper })
    expect(result.current.allTags).toEqual(['Elections'])
    expect(result.current.allTags).not.toContain('Land Records')
  })

  it('allTags fails open when the taxonomy is empty (not yet loaded)', () => {
    const facets: FacetCounts = { ...emptyFacets, tags: { Elections: 3, 'Land Records': 1 } }
    const { result } = renderHook(() => useHarness(facets, []), { wrapper })
    expect(result.current.allTags).toEqual(['Elections', 'Land Records'])
  })

  it('reads subject filters from the URL and writes them back', () => {
    const { result } = renderHook(useHarness, { wrapper: subjectWrapper })
    expect(result.current.selectedSubjects).toEqual(['UT:Election Law'])

    act(() => result.current.handleSubjectsChange(['UT:Referenda', 'UT:Initiatives']))

    const params = new URLSearchParams(result.current.urlSearch)
    expect(params.getAll('subject')).toEqual(['UT:Referenda', 'UT:Initiatives'])
  })

  it('groups subject options by state, sorted by count within each state', () => {
    const facets: FacetCounts = {
      ...emptyFacets,
      subjects: { 'UT:Counties': 2, 'UT:Election Law': 9, 'NJ:Education': 4 },
    }
    const { result } = renderHook(() => useHarness(facets), { wrapper })
    expect(result.current.subjectGroups).toEqual([
      { state: 'NJ', options: [{ value: 'NJ:Education', label: 'Education', count: 4 }] },
      { state: 'UT', options: [
        { value: 'UT:Election Law', label: 'Election Law', count: 9 },
        { value: 'UT:Counties', label: 'Counties', count: 2 },
      ] },
    ])
  })

  describe('handleResetFilters', () => {
    const stage: CustomFieldDef = {
      id: 'cf-stage', name: 'Review Stage', slug: 'review-stage',
      type: 'dropdown', options: ['Not started', 'In review'], displayOrder: 1,
    }

    function cfWrapper({ children }: { children: ReactNode }) {
      return <MemoryRouter initialEntries={['/bills?cf_review-stage=In+review&status=Introduced']}>{children}</MemoryRouter>
    }

    it('clears custom field filters, not just the built-in ones', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [stage]), { wrapper: cfWrapper })
      expect(result.current.cfFilters['cf-stage']).toEqual(['In review'])
      expect(result.current.filterStatuses).toEqual(['Introduced'])

      act(() => result.current.handleResetFilters())

      expect(result.current.filterStatuses).toEqual([])
      expect(result.current.cfFilters).toEqual({})
      expect(result.current.urlSearch).not.toContain('cf_')
      expect(result.current.hasActiveFilters).toBe(false)
    })

    it('clears selected subjects too', () => {
      const { result } = renderHook(useHarness, { wrapper: subjectWrapper })
      expect(result.current.selectedSubjects).toEqual(['UT:Election Law'])

      act(() => result.current.handleResetFilters())

      expect(result.current.selectedSubjects).toEqual([])
      expect(result.current.hasActiveFilters).toBe(false)
    })
  })

  describe('matchAny (group operator)', () => {
    function matchAnyWrapper({ children }: { children: ReactNode }) {
      return <MemoryRouter initialEntries={['/bills?match=any&status=Introduced']}>{children}</MemoryRouter>
    }

    it('hydrates matchAny from ?match=any on mount', () => {
      const { result } = renderHook(useHarness, { wrapper: matchAnyWrapper })
      expect(result.current.matchAny).toBe(true)
    })

    it('does not hydrate matchAny when the param is absent', () => {
      const { result } = renderHook(useHarness, { wrapper })
      expect(result.current.matchAny).toBe(false)
    })

    it('writes match=any to the URL when set, and drops it when cleared', () => {
      const { result } = renderHook(useHarness, { wrapper })
      expect(result.current.urlSearch).not.toContain('match=')

      act(() => result.current.setMatchAny(true))
      expect(new URLSearchParams(result.current.urlSearch).get('match')).toBe('any')

      act(() => result.current.setMatchAny(false))
      expect(new URLSearchParams(result.current.urlSearch).get('match')).toBeNull()
    })

    it('handleResetFilters clears matchAny', () => {
      const { result } = renderHook(useHarness, { wrapper: matchAnyWrapper })
      expect(result.current.matchAny).toBe(true)

      act(() => result.current.handleResetFilters())

      expect(result.current.matchAny).toBe(false)
      expect(result.current.urlSearch).not.toContain('match=')
    })

    // Explicit product decision (Task 6 brief): matchAny is inert with a
    // single active filter group, but it must persist rather than get
    // cleared, so removing and re-adding a group restores the same state.
    // Nothing in useBillFilters ties matchAny to any other filter's count —
    // this pins that absence so a later refactor can't silently add it.
    it('is not cleared when another filter dimension is cleared, leaving one (or zero) groups', () => {
      const { result } = renderHook(useHarness, { wrapper: matchAnyWrapper })
      expect(result.current.matchAny).toBe(true)
      expect(result.current.filterStatuses).toEqual(['Introduced'])

      act(() => result.current.handleStatusClick('Introduced'))

      expect(result.current.filterStatuses).toEqual([])
      expect(result.current.matchAny).toBe(true)
      expect(new URLSearchParams(result.current.urlSearch).get('match')).toBe('any')
    })
  })

  // Regression: cfFilters is lifted state, parsed once against customFieldDefs
  // at the moment a `cf_` key is first read. customFieldDefs loads async, so a
  // mount that beats that fetch used to freeze the key under the raw slug
  // forever (it used to self-heal because cfFilters was re-derived from
  // searchParams every render — lifting it into state, for good reason
  // (see the "applies a cf_ filter from the view" regression), removed that).
  // customFieldDefs arriving later must still correct it in place.
  describe('deferred customFieldDefs resolution', () => {
    const acet: CustomFieldDef = {
      id: 'cf-acet-uuid', name: 'ACET is tracking', slug: 'acet_is_tracking',
      type: 'binary', options: null, displayOrder: 1,
    }

    function cfViewWrapper({ children }: { children: ReactNode }) {
      return <MemoryRouter initialEntries={['/bills?cf_acet_is_tracking=1']}>{children}</MemoryRouter>
    }

    it('mounting before customFieldDefs resolves ends with the correct field id in state', () => {
      const { result, rerender } = renderHook(
        (defs: CustomFieldDef[]) => useHarness(emptyFacets, [], defs),
        { wrapper: cfViewWrapper, initialProps: [] as CustomFieldDef[] },
      )

      // Before defs load: the key is the raw slug (the same fallback the URL
      // sync effect writes back out under, so nothing is lost yet).
      expect(result.current.cfFilters).toEqual({ acet_is_tracking: ['1'] })

      // customFieldDefs resolves.
      rerender([acet])

      // The freeze is gone — the state re-keys itself to the real field id
      // without needing another location.search change.
      expect(result.current.cfFilters).toEqual({ 'cf-acet-uuid': ['1'] })
      expect(result.current.cfFilters['acet_is_tracking']).toBeUndefined()
    })
  })
})
