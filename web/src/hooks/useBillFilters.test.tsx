import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useBillFilters } from './useBillFilters'
import type { CustomFieldDef, FacetCounts } from '../pages/BillList/types'

const emptyFacets: FacetCounts = { status: {}, priority: {}, session: {}, year: {}, state: {}, position: {}, tags: {}, customFields: {}, myBillsCount: 0, newMatchesCount: 0 }

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/bills']}>{children}</MemoryRouter>
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
  })
})
