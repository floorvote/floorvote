import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useSearchParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useBillFilters } from './useBillFilters'
import type { FacetCounts } from '../pages/BillList/types'

const emptyFacets: FacetCounts = { status: {}, priority: {}, session: {}, year: {}, state: {}, position: {}, tags: {}, customFields: {}, myBillsCount: 0, newMatchesCount: 0 }

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/bills']}>{children}</MemoryRouter>
}

function useHarness(facetCounts: FacetCounts = emptyFacets) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  return useBillFilters({
    searchParams, setSearchParams, location,
    facetCounts, customFieldDefs: [], positionVocabulary: ['Support'],
    sortCol: 'default', sortDir: 'asc', setSortCol: () => {}, setSortDir: () => {},
  })
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
})
