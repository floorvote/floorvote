import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useBillFilters } from './useBillFilters'
import type { CustomFieldDef, FacetCounts } from '../pages/BillList/types'
import { EMPTY_BILL_FILTER, parseBillFilter, serializeBillFilter } from '../../../shared/billFilter'

const emptyFacets: FacetCounts = { status: {}, stage: {}, priority: {}, sessionName: {}, year: {}, state: {}, position: {}, tag: {}, subject: {}, field: {}, myBillsCount: 0, newMatchesCount: 0, unvotedCount: 0, draftCount: 0, hasDrafts: false }

function draftsWrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/bills?drafts=1']}>{children}</MemoryRouter>
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/bills']}>{children}</MemoryRouter>
}

function subjectWrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/bills?subject=UT%3AElection+Law']}>{children}</MemoryRouter>
}

function useHarness(facetCounts: FacetCounts = emptyFacets, tagTaxonomy: string[] = [], customFieldDefs: CustomFieldDef[] = []) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const filters = useBillFilters({
    searchParams, setSearchParams, location,
    facetCounts, customFieldDefs, positionVocabulary: ['Support'], tagTaxonomy,
    sortCol: 'default', sortDir: 'asc', setSortCol: () => {}, setSortDir: () => {},
  })
  return { ...filters, urlSearch: location.search, navigate }
}

describe('useBillFilters', () => {
  it('handleStatusClick toggles a status on then off', () => {
    const { result } = renderHook(useHarness, { wrapper })
    act(() => result.current.handleStatusClick('Introduced'))
    expect(result.current.status).toContain('Introduced')
    act(() => result.current.handleStatusClick('Introduced'))
    expect(result.current.status).not.toContain('Introduced')
  })

  it('hasActiveFilters reflects an applied filter', () => {
    const { result } = renderHook(useHarness, { wrapper })
    expect(result.current.hasActiveFilters).toBe(false)
    act(() => result.current.setMyBills(true))
    expect(result.current.hasActiveFilters).toBe(true)
  })

  it('allTags excludes the FILTER_ANY sentinel that the facets API returns', () => {
    const facets: FacetCounts = { ...emptyFacets, tag: { elections: 3, voting: 2, __any__: 4 } }
    const { result } = renderHook(() => useHarness(facets), { wrapper })
    expect(result.current.allTags).toEqual(['elections', 'voting'])
    expect(result.current.allTags).not.toContain('__any__')
  })

  it('allTags excludes tags not in the taxonomy', () => {
    const facets: FacetCounts = { ...emptyFacets, tag: { Elections: 3, 'Land Records': 1, __any__: 4 } }
    const { result } = renderHook(() => useHarness(facets, ['Elections']), { wrapper })
    expect(result.current.allTags).toEqual(['Elections'])
    expect(result.current.allTags).not.toContain('Land Records')
  })

  it('allTags fails open when the taxonomy is empty (not yet loaded)', () => {
    const facets: FacetCounts = { ...emptyFacets, tag: { Elections: 3, 'Land Records': 1 } }
    const { result } = renderHook(() => useHarness(facets, []), { wrapper })
    expect(result.current.allTags).toEqual(['Elections', 'Land Records'])
  })

  it('reads subject filters from the URL and writes them back', () => {
    const { result } = renderHook(useHarness, { wrapper: subjectWrapper })
    expect(result.current.subject).toEqual(['UT:Election Law'])

    act(() => result.current.handleSubjectsChange(['UT:Referenda', 'UT:Initiatives']))

    const params = new URLSearchParams(result.current.urlSearch)
    expect(params.getAll('subject')).toEqual(['UT:Referenda', 'UT:Initiatives'])
  })

  it('groups subject options by state, sorted by count within each state', () => {
    const facets: FacetCounts = {
      ...emptyFacets,
      subject: { 'UT:Counties': 2, 'UT:Election Law': 9, 'NJ:Education': 4 },
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
      return <MemoryRouter initialEntries={['/bills?field.review-stage=In+review&status=Introduced']}>{children}</MemoryRouter>
    }

    it('clears custom field filters, not just the built-in ones', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [stage]), { wrapper: cfWrapper })
      expect(result.current.field['cf-stage']).toEqual(['In review'])
      expect(result.current.status).toEqual(['Introduced'])

      act(() => result.current.handleResetFilters())

      expect(result.current.status).toEqual([])
      expect(result.current.field).toEqual({})
      expect(result.current.urlSearch).not.toContain('field.')
      expect(result.current.hasActiveFilters).toBe(false)
    })

    it('clears selected subjects too', () => {
      const { result } = renderHook(useHarness, { wrapper: subjectWrapper })
      expect(result.current.subject).toEqual(['UT:Election Law'])

      act(() => result.current.handleResetFilters())

      expect(result.current.subject).toEqual([])
      expect(result.current.hasActiveFilters).toBe(false)
    })
  })

  describe('match (group operator)', () => {
    function matchWrapper({ children }: { children: ReactNode }) {
      return <MemoryRouter initialEntries={['/bills?match=any&status=Introduced']}>{children}</MemoryRouter>
    }

    it('hydrates match from ?match=any on mount', () => {
      const { result } = renderHook(useHarness, { wrapper: matchWrapper })
      expect(result.current.match).toBe('any')
    })

    it('does not hydrate match when the param is absent', () => {
      const { result } = renderHook(useHarness, { wrapper })
      expect(result.current.match).toBe('all')
    })

    it('writes match=any to the URL when set, and drops it when cleared', () => {
      const { result } = renderHook(useHarness, { wrapper })
      expect(result.current.urlSearch).not.toContain('match=')

      act(() => result.current.setMatch('any'))
      expect(new URLSearchParams(result.current.urlSearch).get('match')).toBe('any')

      act(() => result.current.setMatch('all'))
      expect(new URLSearchParams(result.current.urlSearch).get('match')).toBeNull()
    })

    it('handleResetFilters clears match', () => {
      const { result } = renderHook(useHarness, { wrapper: matchWrapper })
      expect(result.current.match).toBe('any')

      act(() => result.current.handleResetFilters())

      expect(result.current.match).toBe('all')
      expect(result.current.urlSearch).not.toContain('match=')
    })

    // Explicit product decision (Task 6 brief): match is inert with a
    // single active filter group, but it must persist rather than get
    // cleared, so removing and re-adding a group restores the same state.
    // Nothing in useBillFilters ties match to any other filter's count —
    // this pins that absence so a later refactor can't silently add it.
    it('is not cleared when another filter dimension is cleared, leaving one (or zero) groups', () => {
      const { result } = renderHook(useHarness, { wrapper: matchWrapper })
      expect(result.current.match).toBe('any')
      expect(result.current.status).toEqual(['Introduced'])

      act(() => result.current.handleStatusClick('Introduced'))

      expect(result.current.status).toEqual([])
      expect(result.current.match).toBe('any')
      expect(new URLSearchParams(result.current.urlSearch).get('match')).toBe('any')
    })
  })

  describe('stage', () => {
    function stageWrapper({ children }: { children: ReactNode }) {
      return <MemoryRouter initialEntries={['/bills?stage=enacted']}>{children}</MemoryRouter>
    }

    it('reads the stage filter from the URL and writes it back', () => {
      const { result } = renderHook(useHarness, { wrapper: stageWrapper })
      expect(result.current.stage).toEqual(['enacted'])
      expect(result.current.hasActiveFilters).toBe(true)
      expect(result.current.totalActiveFilters).toBe(1)

      act(() => result.current.setStage(['enacted', 'vetoed']))
      expect(new URLSearchParams(result.current.urlSearch).getAll('stage')).toEqual(['enacted', 'vetoed'])
    })

    it('handleResetFilters clears it', () => {
      const { result } = renderHook(useHarness, { wrapper: stageWrapper })
      act(() => result.current.handleResetFilters())
      expect(result.current.stage).toEqual([])
      expect(result.current.urlSearch).not.toContain('stage=')
    })

    it('offers every stage, most advanced first', () => {
      const { result } = renderHook(useHarness, { wrapper })
      expect(result.current.stageOptions.map(o => o.label)).toEqual([
        'Enacted', 'Vetoed', 'Failed', 'Passed legislature', 'Passed one chamber', 'In committee', 'Introduced',
      ])
    })
  })

  describe('drafts', () => {
    it('mounting at ?drafts=1 reads it back as active', () => {
      const { result } = renderHook(useHarness, { wrapper: draftsWrapper })
      expect(result.current.drafts).toBe(true)
    })

    it('toggling drafts writes drafts=1 to the URL, and drops it when cleared', () => {
      const { result } = renderHook(useHarness, { wrapper })
      expect(result.current.urlSearch).not.toContain('drafts=')

      act(() => result.current.setDrafts(true))
      expect(new URLSearchParams(result.current.urlSearch).get('drafts')).toBe('1')

      act(() => result.current.setDrafts(false))
      expect(new URLSearchParams(result.current.urlSearch).get('drafts')).toBeNull()
    })

    it('handleResetFilters clears drafts', () => {
      const { result } = renderHook(useHarness, { wrapper: draftsWrapper })
      expect(result.current.drafts).toBe(true)

      act(() => result.current.handleResetFilters())

      expect(result.current.drafts).toBe(false)
      expect(result.current.urlSearch).not.toContain('drafts=')
    })
  })

  // Regression: field is lifted state, parsed once against customFieldDefs
  // at the moment a `field.` key is first read. customFieldDefs loads async, so a
  // mount that beats that fetch used to freeze the key under the raw slug
  // forever (it used to self-heal because field was re-derived from
  // searchParams every render — lifting it into state, for good reason
  // (see the "applies a field. filter from the view" regression), removed that).
  // customFieldDefs arriving later must still correct it in place.
  describe('deferred customFieldDefs resolution', () => {
    const acet: CustomFieldDef = {
      id: 'cf-acet-uuid', name: 'ACET is tracking', slug: 'acet_is_tracking',
      type: 'binary', options: null, displayOrder: 1,
    }

    function cfViewWrapper({ children }: { children: ReactNode }) {
      return <MemoryRouter initialEntries={['/bills?field.acet_is_tracking=1']}>{children}</MemoryRouter>
    }

    it('mounting before customFieldDefs resolves ends with the correct field id in state', () => {
      const { result, rerender } = renderHook(
        (defs: CustomFieldDef[]) => useHarness(emptyFacets, [], defs),
        { wrapper: cfViewWrapper, initialProps: [] as CustomFieldDef[] },
      )

      // Before defs load: the key is the raw slug (the same fallback the URL
      // sync effect writes back out under, so nothing is lost yet).
      expect(result.current.field).toEqual({ acet_is_tracking: ['1'] })

      // customFieldDefs resolves.
      rerender([acet])

      // The freeze is gone — the state re-keys itself to the real field id
      // without needing another location.search change.
      expect(result.current.field).toEqual({ 'cf-acet-uuid': ['1'] })
      expect(result.current.field['acet_is_tracking']).toBeUndefined()
    })
  })
})

// The hook holds one immutable bill filter value, the shared module's, and every way to change a filter goes
// through it: a control, an edit to the URL, a saved view, and Reset.
describe('useBillFilters holds one bill filter value', () => {
  const CF: CustomFieldDef = {
    id: 'cf-team', name: 'Team', slug: 'team', type: 'dropdown', options: ['Alpha', 'Beta'], displayOrder: 1,
  }
  const at = (url: string) => function UrlWrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
  }

  it('reads the URL with the shared parse, on mount', () => {
    const qs = 'status=Introduced&stage=enacted&year=2026&state=UT&position=none&priority=high&tag=Water&subject=UT%3AElections&minRelevance=4&myBills=1&unvoted=1&newMatches=1&drafts=1&match=any'
    const { result } = renderHook(useHarness, { wrapper: at(`/bills?${qs}`) })
    expect(result.current.filter).toEqual(parseBillFilter(qs))
  })

  it('is empty for a bare /bills', () => {
    const { result } = renderHook(useHarness, { wrapper })
    expect(result.current.filter).toEqual(EMPTY_BILL_FILTER)
  })

  it('is immutable: the value and its lists are frozen', () => {
    const { result } = renderHook(useHarness, { wrapper: at('/bills?status=Introduced&field.team=Alpha') })
    const f = result.current.filter
    expect(Object.isFrozen(f)).toBe(true)
    expect(Object.isFrozen(f.status)).toBe(true)
    expect(Object.isFrozen(f.field)).toBe(true)
  })

  it('makes a new value for a change, and leaves the old one as it was', () => {
    const { result } = renderHook(useHarness, { wrapper })
    const before = result.current.filter
    act(() => result.current.handleStatusClick('Introduced'))
    const after = result.current.filter
    expect(after).not.toBe(before)
    expect(before.status).toEqual([])
    expect(after.status).toEqual(['Introduced'])
  })

  it('keeps the same value across a render that changes nothing, so nothing that depends on it runs again', () => {
    const { result, rerender } = renderHook(useHarness, { wrapper: at('/bills?status=Introduced') })
    const before = result.current.filter
    rerender()
    expect(result.current.filter).toBe(before)
  })

  it('keeps the same value when a control sets what is already set', () => {
    const { result } = renderHook(useHarness, { wrapper: at('/bills?status=Introduced&myBills=1') })
    const before = result.current.filter
    act(() => result.current.setStatus(['Introduced']))
    act(() => result.current.setMyBills(true))
    expect(result.current.filter).toBe(before)
  })

  it.each([
    ['status', (r: ReturnType<typeof useHarness>) => r.setStatus(['a', 'b']), { status: ['a', 'b'] }],
    ['stage', (r: ReturnType<typeof useHarness>) => r.setStage(['enacted']), { stage: ['enacted'] }],
    ['priority', (r: ReturnType<typeof useHarness>) => r.setPriority(['high']), { priority: ['high'] }],
    ['position', (r: ReturnType<typeof useHarness>) => r.setPosition(['none']), { position: ['none'] }],
    ['year', (r: ReturnType<typeof useHarness>) => r.setYear([2026, 2025]), { year: ['2026', '2025'] }],
    ['state', (r: ReturnType<typeof useHarness>) => r.setState(['UT']), { state: ['UT'] }],
    ['min relevance', (r: ReturnType<typeof useHarness>) => r.setMinRelevance(5), { minRelevance: 5 }],
    ['my bills', (r: ReturnType<typeof useHarness>) => r.setMyBills(true), { myBills: true }],
    ['unvoted', (r: ReturnType<typeof useHarness>) => r.setUnvoted(true), { unvoted: true }],
    ['new matches', (r: ReturnType<typeof useHarness>) => r.setNewMatches(true), { newMatches: true }],
    ['drafts', (r: ReturnType<typeof useHarness>) => r.setDrafts(true), { drafts: true }],
    ['match', (r: ReturnType<typeof useHarness>) => r.setMatch('any'), { match: 'any' }],
    ['tags', (r: ReturnType<typeof useHarness>) => r.handleTagsChange(['Water']), { tag: ['Water'] }],
    ['subjects', (r: ReturnType<typeof useHarness>) => r.handleSubjectsChange(['UT:Elections']), { subject: [{ state: 'UT', name: 'Elections' }] }],
    ['search', (r: ReturnType<typeof useHarness>) => r.setSearch('water'), { search: 'water' }],
    ['a custom field', (r: ReturnType<typeof useHarness>) => r.setField('cf-team', ['Alpha']), { field: { 'cf-team': ['Alpha'] } }],
  ])('%s: the control writes its part of the one value', (_name, change, expected) => {
    const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper })
    act(() => change(result.current))
    expect(result.current.filter).toEqual({ ...EMPTY_BILL_FILTER, ...expected })
  })

  it('reads min relevance of zero as none', () => {
    const { result } = renderHook(useHarness, { wrapper: at('/bills?minRelevance=5') })
    act(() => result.current.setMinRelevance(0))
    expect(result.current.filter.minRelevance).toBeNull()
    expect(result.current.urlSearch).not.toContain('minRelevance')
  })

  describe('the URL', () => {
    it('is written from the value with the shared serialize, in its one key order', () => {
      const { result } = renderHook(useHarness, { wrapper })
      act(() => result.current.setPriority(['high']))
      act(() => result.current.setYear([2026]))
      act(() => result.current.setStatus(['Introduced']))
      expect(result.current.urlSearch).toBe(`?${serializeBillFilter(result.current.filter)}`)
      expect(result.current.urlSearch).toBe('?status=Introduced&year=2026&priority=high')
    })

    it('names a custom field by its slug, though the value holds it by its id', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper })
      act(() => result.current.setField('cf-team', ['Alpha', 'Beta']))
      expect(result.current.filter.field).toEqual({ 'cf-team': ['Alpha', 'Beta'] })
      expect(result.current.urlSearch).toBe('?field.team=Alpha&field.team=Beta')
    })

    it('never carries the search box', () => {
      const { result } = renderHook(useHarness, { wrapper })
      act(() => result.current.setSearch('water'))
      expect(result.current.filter.search).toBe('water')
      expect(result.current.urlSearch).not.toContain('water')
      expect(result.current.urlSearch).not.toContain('search=')
    })

    it('an edit to it replaces the filters, through the same parse, and leaves the search box alone', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper: at('/bills?status=Introduced') })
      act(() => result.current.setSearch('water'))
      act(() => result.current.navigate('/bills?stage=enacted&priority=high&field.team=Beta&match=any'))
      expect(result.current.filter).toEqual({
        ...parseBillFilter('stage=enacted&priority=high&match=any'),
        field: { 'cf-team': ['Beta'] },
        search: 'water',
      })
      expect(result.current.status).toEqual([])
    })

    it('an edit to it that is the filter as it stands changes nothing', () => {
      const { result } = renderHook(useHarness, { wrapper: at('/bills?status=Introduced') })
      const before = result.current.filter
      act(() => result.current.navigate('/bills?status=Introduced'))
      expect(result.current.filter).toBe(before)
    })

    it('ignores session, which the page has no control for, so nothing narrows the list unseen', () => {
      const { result } = renderHook(useHarness, { wrapper: at('/bills?sessionName=S1&status=Introduced') })
      expect(result.current.filter.sessionName).toEqual([])
      act(() => result.current.setStatus([]))
      expect(result.current.urlSearch).toBe('')
      act(() => result.current.navigate('/bills?sessionName=S2'))
      expect(result.current.filter.sessionName).toEqual([])
    })
  })

  describe('a saved view', () => {
    it('is applied by parsing its query into the value, the search box cleared', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper })
      act(() => result.current.setSearch('water'))
      act(() => result.current.applyView({ id: 'v1', slug: 'inbox', query: 'status=Introduced&priority=high&field.team=Alpha&match=any' }))
      expect(result.current.filter).toEqual({
        ...parseBillFilter('status=Introduced&priority=high&match=any'),
        field: { 'cf-team': ['Alpha'] },
      })
    })

    it('holds a custom field named by its id in the view as the same field', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper })
      act(() => result.current.applyView({ id: 'v1', slug: 'inbox', query: 'field.cf-team=Alpha&field.team=Beta' }))
      expect(result.current.filter.field).toEqual({ 'cf-team': ['Alpha', 'Beta'] })
    })

    it('replaces every filter the view does not name', () => {
      const { result } = renderHook(useHarness, { wrapper: at('/bills?stage=enacted&myBills=1&tag=Water') })
      act(() => result.current.applyView({ id: 'v1', slug: 'inbox', query: 'status=Introduced' }))
      expect(result.current.filter).toEqual({ ...EMPTY_BILL_FILTER, status: ['Introduced'] })
    })

    it('ignores a session in the view, as it does in the URL', () => {
      const { result } = renderHook(useHarness, { wrapper })
      act(() => result.current.applyView({ id: 'v1', slug: 'inbox', query: 'status=Introduced&sessionName=S1' }))
      expect(result.current.filter).toEqual({ ...EMPTY_BILL_FILTER, status: ['Introduced'] })
    })

    it('the null view is the empty filter', () => {
      const { result } = renderHook(useHarness, { wrapper: at('/bills?stage=enacted&myBills=1') })
      act(() => result.current.applyView(null))
      expect(result.current.filter).toEqual(EMPTY_BILL_FILTER)
    })
  })

  describe('Reset', () => {
    it('sets the empty bill filter, every filter at once, search and custom fields included', () => {
      const qs = 'status=Introduced&stage=enacted&year=2026&state=UT&position=none&priority=high&tag=Water&subject=UT%3AElections&minRelevance=4&myBills=1&unvoted=1&newMatches=1&drafts=1&match=any&field.team=Alpha'
      const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper: at(`/bills?${qs}`) })
      act(() => result.current.setSearch('water'))
      expect(result.current.filter).not.toEqual(EMPTY_BILL_FILTER)

      act(() => result.current.handleResetFilters())

      expect(result.current.filter).toEqual(EMPTY_BILL_FILTER)
      expect(result.current.urlSearch).toBe('')
      expect(result.current.hasActiveFilters).toBe(false)
    })

    it('clears the group operator too', () => {
      const { result } = renderHook(useHarness, { wrapper: at('/bills?match=any') })
      act(() => result.current.handleResetFilters())
      expect(result.current.filter.match).toBe('all')
    })
  })

  describe('custom field defs that arrive late', () => {
    it('re-key the value from the slug to the id, as a new value', () => {
      const { result, rerender } = renderHook(
        (defs: CustomFieldDef[]) => useHarness(emptyFacets, [], defs),
        { wrapper: at('/bills?field.team=Alpha'), initialProps: [] as CustomFieldDef[] },
      )
      const before = result.current.filter
      expect(before.field).toEqual({ team: ['Alpha'] })
      rerender([CF])
      expect(result.current.filter.field).toEqual({ 'cf-team': ['Alpha'] })
      expect(before.field).toEqual({ team: ['Alpha'] })
      expect(result.current.urlSearch).toBe('?field.team=Alpha')
    })

    it('leave the value as it is when no field needs a new key', () => {
      const { result, rerender } = renderHook(
        (defs: CustomFieldDef[]) => useHarness(emptyFacets, [], defs),
        { wrapper: at('/bills?status=Introduced'), initialProps: [] as CustomFieldDef[] },
      )
      const before = result.current.filter
      rerender([CF])
      expect(result.current.filter).toBe(before)
    })
  })

  // One name per filter (#699): the URL keys `q`, `cf_<slug>`, and `session` became `search`, `field.<slug>`, and
  // `sessionName`, with no aliases, so a link or view written with an old key applies nothing for it.
  describe('the old URL keys', () => {
    it('ignores cf_<slug> in the URL', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper: at('/bills?cf_team=Alpha&status=Introduced') })
      expect(result.current.field).toEqual({})
      expect(result.current.status).toEqual(['Introduced'])
      expect(result.current.urlSearch).toBe('?status=Introduced')
    })

    it('ignores cf_<slug> in a saved view', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper: at('/bills') })
      act(() => result.current.applyView({ id: 'v1', slug: 'old', query: 'cf_team=Alpha&priority=high' }))
      expect(result.current.field).toEqual({})
      expect(result.current.priority).toEqual(['high'])
    })

    it('reads field.<slug> in a saved view', () => {
      const { result } = renderHook(() => useHarness(emptyFacets, [], [CF]), { wrapper: at('/bills') })
      act(() => result.current.applyView({ id: 'v1', slug: 'new', query: 'field.team=Alpha&priority=high' }))
      expect(result.current.field).toEqual({ 'cf-team': ['Alpha'] })
    })

    it('reads search, not q, from a list URL the pane summarizes', () => {
      expect(parseBillFilter('q=water').search).toBe('')
      expect(parseBillFilter('search=water').search).toBe('water')
    })
  })
})
