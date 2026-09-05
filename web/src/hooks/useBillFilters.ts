import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { useSearchParams } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import type { CustomFieldDef, FacetCounts, SortColumn, SortDir } from '../pages/BillList/types'
import { STATUS_SEMANTIC_ORDER } from '../pages/BillList/constants'
import { FILTER_ANY } from '../pages/BillList/FilterPanel'
import { knownStates, knownStatuses, knownTagsCache } from '../pages/BillList'
import { normalizeViewQuery } from '../lib/savedViews'

type SearchParams = ReturnType<typeof useSearchParams>[0]
type SetSearchParams = ReturnType<typeof useSearchParams>[1]

const SORT_COLS: SortColumn[] = ['priority', 'status', 'relevance', 'position', 'year', 'session', 'lastAction', 'bill']

export type ViewLike = { id: string; slug?: string; query: string }

export function useBillFilters(opts: {
  searchParams: SearchParams
  setSearchParams: SetSearchParams
  location: Location
  facetCounts: FacetCounts
  customFieldDefs: CustomFieldDef[]
  positionVocabulary: string[]
  tagTaxonomy: string[]
  sortCol: SortColumn
  sortDir: SortDir
  setSortCol: (c: SortColumn) => void
  setSortDir: (d: SortDir) => void
}) {
  const { searchParams, setSearchParams, location, facetCounts, customFieldDefs, positionVocabulary, tagTaxonomy, sortCol, sortDir, setSortCol, setSortDir } = opts

  const [search, setSearch] = useState('')
  const [filterStatuses, setFilterStatuses] = useState<string[]>(() => searchParams.getAll('status'))
  const [filterPriorities, setFilterPriorities] = useState<string[]>(() => searchParams.getAll('priority'))
  const [filterPositions, setFilterPositions] = useState<string[]>(() => searchParams.getAll('position'))
  const [filterYears, setFilterYears] = useState<number[]>(() =>
    searchParams.getAll('year').map(Number).filter(n => !isNaN(n))
  )
  const [filterStates, setFilterStates] = useState<string[]>(() => searchParams.getAll('state'))
  const [filterMinRelevance, setFilterMinRelevance] = useState(() => {
    const r = searchParams.get('minRelevance')
    return r ? Number(r) : 0
  })
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [myBills, setMyBills] = useState(() => searchParams.get('myBills') === '1')
  const [unvotedOnly, setUnvotedOnly] = useState(() => searchParams.get('unvoted') === '1')
  const [newMatches, setNewMatches] = useState(() => searchParams.get('newMatches') === '1')
  const [selectedTags, setSelectedTags] = useState<string[]>(() => searchParams.getAll('tag'))
  const [selectedSubjects, setSelectedSubjects] = useState<string[]>(
    () => searchParams.getAll('subject'),
  )
  const [cfFilters, setCfFilters] = useState<Record<string, string[]>>(() => {
    const filters: Record<string, string[]> = {}
    for (const [key, value] of searchParams.entries()) {
      if (key.startsWith('cf_')) {
        const slugOrId = key.slice(3)
        const def = customFieldDefs.find(d => d.slug === slugOrId || d.id === slugOrId)
        const fieldId = def?.id ?? slugOrId
        if (!filters[fieldId]) filters[fieldId] = []
        if (!filters[fieldId].includes(value)) filters[fieldId].push(value)
      }
    }
    return filters
  })
  const lastWrittenSearch = useRef(location.search)
  useEffect(() => {
    if (location.search === lastWrittenSearch.current) return
    const params = new URLSearchParams(location.search)
    setFilterStatuses(params.getAll('status'))
    setFilterPriorities(params.getAll('priority'))
    setFilterPositions(params.getAll('position'))
    setFilterYears(params.getAll('year').map(Number).filter(n => !isNaN(n)))
    setFilterStates(params.getAll('state'))
    const r = params.get('minRelevance')
    setFilterMinRelevance(r ? Number(r) : 0)
    setMyBills(params.get('myBills') === '1')
    setUnvotedOnly(params.get('unvoted') === '1')
    setNewMatches(params.get('newMatches') === '1')
    setSelectedTags(params.getAll('tag'))
    setSelectedSubjects(params.getAll('subject'))
    const cfNext: Record<string, string[]> = {}
    for (const [key, value] of params.entries()) {
      if (key.startsWith('cf_')) {
        const slugOrId = key.slice(3)
        const def = customFieldDefs.find(d => d.slug === slugOrId || d.id === slugOrId)
        const fieldId = def?.id ?? slugOrId
        if (!cfNext[fieldId]) cfNext[fieldId] = []
        if (!cfNext[fieldId].includes(value)) cfNext[fieldId].push(value)
      }
    }
    setCfFilters(cfNext)
    const s = params.get('sort')
    if (s && ['priority', 'status', 'relevance', 'position', 'year', 'session', 'lastAction', 'bill'].includes(s)) {
      setSortCol(s as SortColumn)
    } else {
      setSortCol('default')
    }
    const d = params.get('dir')
    setSortDir(d === 'desc' ? 'desc' : 'asc')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  const currentFilters = useMemo(() => ({
    status: filterStatuses,
    priority: filterPriorities,
    position: filterPositions,
    year: filterYears.map(String),
    state: filterStates,
    tag: selectedTags,
    subject: selectedSubjects,
    q: search,
    minRelevance: filterMinRelevance,
    myBills,
    unvoted: unvotedOnly,
    newMatches,
    cf: cfFilters,
  }), [filterStatuses, filterPriorities, filterPositions, filterYears, filterStates, selectedTags, selectedSubjects, search, filterMinRelevance, myBills, unvotedOnly, newMatches, cfFilters])

  function setCfFilter(fieldId: string, values: string[]) {
    setCfFilters(prev => ({ ...prev, [fieldId]: values }))
  }

  // Tracks whether the currently-applied filters were put there by applying a
  // saved view (via applyView, below, or BillList's cold-load hydration of a
  // bookmarked `?view=<slug-or-id>`), and if so, which view (by the identifier
  // that belongs in the URL) and what its query normalizes to.
  //   - `undefined` (initial): never interacted with via applyView — a `view`
  //     param already in the URL (a bookmark) is preserved as-is; BillList's
  //     separate stale-slug guard validates it once the /views fetch resolves.
  //   - `null`: explicitly not tracking a view (applyView(null), a filter
  //     edit that diverged from the tracked view, or "Reset filters").
  //   - a view's slug (or its id, if it has no slug yet): tracking that view;
  //     the sync effect below collapses the URL to the short `?view=<slug>`
  //     form as long as the built query keeps matching pendingViewQuery, and
  //     drops both the moment it stops.
  const pendingViewId = useRef<string | null | undefined>(undefined)
  const pendingViewQuery = useRef<string | null>(null)

  useEffect(() => {
    const next = new URLSearchParams()
    filterStatuses.forEach(s => next.append('status', s))
    filterPriorities.forEach(p => next.append('priority', p))
    filterPositions.forEach(p => next.append('position', p))
    filterYears.forEach(y => next.append('year', String(y)))
    filterStates.forEach(s => next.append('state', s))
    if (filterMinRelevance > 0) next.set('minRelevance', String(filterMinRelevance))
    if (myBills) next.set('myBills', '1')
    if (unvotedOnly) next.set('unvoted', '1')
    if (newMatches) next.set('newMatches', '1')
    selectedTags.forEach(t => next.append('tag', t))
    selectedSubjects.forEach(s => next.append('subject', s))
    if (sortCol !== 'default') {
      next.set('sort', sortCol)
      next.set('dir', sortDir)
    }
    // cf_ params now live in hook state (cfFilters) like every other
    // dimension, so this effect is the sole writer of the query string —
    // serialize them the same way setCfFilter used to derive the URL key.
    for (const [fieldId, values] of Object.entries(cfFilters)) {
      const def = customFieldDefs.find(d => d.id === fieldId)
      const urlKey = `cf_${def?.slug ?? fieldId}`
      for (const v of values) next.append(urlKey, v)
    }
    // A `view` param never touched by applyView (pendingViewId still at its
    // initial `undefined`) is a bookmark — preserved as-is. BillList's
    // separate stale-slug guard is what validates it once the /views fetch
    // resolves.
    if (pendingViewId.current === undefined) {
      const existingView = searchParams.get('view')
      if (existingView) next.set('view', existingView)
    } else if (pendingViewId.current !== null) {
      // A view is being tracked: the bookmark stays the short `?view=<id>`
      // form for as long as the filters applied now — cf_ included, from
      // the `next` params this effect is itself about to write — still
      // match it.
      const nextNormalized = normalizeViewQuery('?' + next.toString())
      if (nextNormalized === pendingViewQuery.current) {
        const short = new URLSearchParams()
        short.set('view', pendingViewId.current)
        lastWrittenSearch.current = '?' + short.toString()
        setSearchParams(short, { replace: true })
        return
      }
      // Diverged from the tracked view — drop it now and fall through to a
      // full expanded write, rather than resurrecting it below.
      pendingViewId.current = null
      pendingViewQuery.current = null
    }
    const searchStr = '?' + next.toString()
    lastWrittenSearch.current = searchStr
    setSearchParams(next, { replace: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatuses, filterPriorities, filterPositions, filterYears, filterStates, filterMinRelevance, myBills, unvotedOnly, newMatches, selectedTags, selectedSubjects, sortCol, sortDir, cfFilters])

  const handleTagClick = useCallback((tag: string) => {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])
  }, [])

  const handleTagsChange = useCallback((tags: string[]) => {
    setSelectedTags(tags)
  }, [])

  const handleSubjectsChange = useCallback((next: string[]) => setSelectedSubjects(next), [])

  const handleStatusClick = useCallback((status: string) => {
    setFilterStatuses(prev => prev.includes(status) ? prev.filter(s => s !== status) : [...prev, status])
  }, [])

  const handlePriorityClick = useCallback((priority: string) => {
    setFilterPriorities(prev => prev.includes(priority) ? prev.filter(p => p !== priority) : [...prev, priority])
  }, [])

  const handlePositionClick = useCallback((position: string) => {
    setFilterPositions(prev => prev.includes(position) ? prev.filter(p => p !== position) : [...prev, position])
  }, [])

  const handleYearClick = useCallback((year: number) => {
    setFilterYears(prev => prev.includes(year) ? prev.filter(y => y !== year) : [...prev, year])
  }, [])

  const handleRelevanceClick = useCallback((score: number) => {
    setFilterMinRelevance(prev => prev === score ? 0 : score)
  }, [])

  const handleResetFilters = useCallback(() => {
    pendingViewId.current = null
    pendingViewQuery.current = null
    setSearch('')
    setFilterStatuses([])
    setFilterPriorities([])
    setFilterPositions([])
    setFilterYears([])
    setFilterStates([])
    setFilterMinRelevance(0)
    setMyBills(false)
    setUnvotedOnly(false)
    setNewMatches(false)
    setSelectedTags([])
    setSelectedSubjects([])
    setCfFilters({})
  }, [])

  // Applies a saved view's stored query to filter state — used both when the
  // user picks a view from the switcher and when BillList hydrates a
  // bookmarked `?view=<id>` on cold load. Sets filter state and marks the
  // view as tracked (see the pendingViewId ref comment above); it never calls
  // setSearchParams itself, leaving the sync effect above as the sole writer
  // of the query string, per the design doc.
  const applyView = useCallback((view: ViewLike | null) => {
    setSearch('')
    if (!view) {
      handleResetFilters()
      return
    }
    const params = new URLSearchParams(view.query)
    // Prefer the slug for the URL — falling back to the id only covers a view
    // that predates the slug backfill reaching it (the /views response should
    // always carry one by the time this runs, but the fallback keeps this
    // safe rather than writing `?view=undefined`).
    pendingViewId.current = view.slug ?? view.id
    pendingViewQuery.current = normalizeViewQuery(view.query)
    setFilterStatuses(params.getAll('status'))
    setFilterPriorities(params.getAll('priority'))
    setFilterPositions(params.getAll('position'))
    setFilterYears(params.getAll('year').map(Number).filter(n => !isNaN(n)))
    setFilterStates(params.getAll('state'))
    const r = params.get('minRelevance')
    setFilterMinRelevance(r ? Number(r) : 0)
    setMyBills(params.get('myBills') === '1')
    setUnvotedOnly(params.get('unvoted') === '1')
    setNewMatches(params.get('newMatches') === '1')
    setSelectedTags(params.getAll('tag'))
    setSelectedSubjects(params.getAll('subject'))
    const s = params.get('sort')
    setSortCol(s && SORT_COLS.includes(s as SortColumn) ? (s as SortColumn) : 'default')
    const d = params.get('dir')
    setSortDir(d === 'desc' ? 'desc' : 'asc')
    const cfNext: Record<string, string[]> = {}
    for (const [key, value] of params.entries()) {
      if (key.startsWith('cf_')) {
        const slugOrId = key.slice(3)
        const def = customFieldDefs.find(d => d.slug === slugOrId || d.id === slugOrId)
        const fieldId = def?.id ?? slugOrId
        if (!cfNext[fieldId]) cfNext[fieldId] = []
        if (!cfNext[fieldId].includes(value)) cfNext[fieldId].push(value)
      }
    }
    setCfFilters(cfNext)
  }, [customFieldDefs, handleResetFilters, setSortCol, setSortDir])

  const hasActiveFilters = !!(
    search || filterStatuses.length > 0 || filterPriorities.length > 0 || filterPositions.length > 0 ||
    filterYears.length > 0 || filterStates.length > 0 || filterMinRelevance > 0 || selectedTags.length > 0 || selectedSubjects.length > 0 || myBills || unvotedOnly || newMatches ||
    Object.keys(cfFilters).some(k => (cfFilters[k]?.length ?? 0) > 0)
  )

  const totalActiveFilters = filterStatuses.length + filterPriorities.length + filterPositions.length + selectedTags.length + selectedSubjects.length + filterYears.length + filterStates.length + (filterMinRelevance > 0 ? 1 : 0) + (myBills ? 1 : 0) + (unvotedOnly ? 1 : 0) + (newMatches ? 1 : 0) + Object.values(cfFilters).reduce((sum, v) => sum + v.length, 0)

  const yearFacetKeys = useMemo(() => {
    return Object.keys(facetCounts.year)
      .map(Number)
      .filter(n => !isNaN(n) && n > 0)
      .sort((a, b) => b - a) // most recent first
      .map(String)
  }, [facetCounts.year])

  const statuses = useMemo(() => {
    const all = [...new Set([...knownStatuses, ...Object.keys(facetCounts.status)])]
    return all.sort((a, b) => {
      const ai = STATUS_SEMANTIC_ORDER.indexOf(a)
      const bi = STATUS_SEMANTIC_ORDER.indexOf(b)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
  }, [facetCounts.status])
  // Options come from the facets API + the session-sticky knownTagsCache, but a tag removed
  // from the taxonomy must never be selectable. Intersect with the taxonomy; fail open (show all)
  // while the taxonomy is still loading, so options never briefly vanish.
  const allTags = useMemo(() => {
    const taxonomySet = new Set(tagTaxonomy)
    return [...new Set([...knownTagsCache, ...Object.keys(facetCounts.tags)])]
      .filter(t => t !== FILTER_ANY && (taxonomySet.size === 0 || taxonomySet.has(t)))
      .sort()
  }, [facetCounts.tags, tagTaxonomy])
  const positionOptions = useMemo(
    () => [...positionVocabulary.map(p => ({ value: p })), { value: 'none', label: 'Not set' }],
    [positionVocabulary]
  )

  /**
   * Grouped by state because the vocabularies are not comparable across states —
   * a flat list would put New Jersey's 44 coarse terms beside Arizona's 6,449
   * fine-grained ones under headings that mean different things.
   */
  const subjectGroups = useMemo(() => {
    const byState = new Map<string, Array<{ value: string; label: string; count: number }>>()
    for (const [value, count] of Object.entries(facetCounts.subjects ?? {})) {
      const idx = value.indexOf(':')
      if (idx <= 0) continue
      const state = value.slice(0, idx)
      const label = value.slice(idx + 1)
      if (!byState.has(state)) byState.set(state, [])
      byState.get(state)!.push({ value, label, count })
    }
    return [...byState.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([state, options]) => ({
        state,
        options: options.sort((x, y) => y.count - x.count || x.label.localeCompare(y.label)),
      }))
  }, [facetCounts.subjects])

  const uniqueStates = [...new Set([...knownStates, ...Object.keys(facetCounts.state)])].sort((a, b) => {
    if (a === 'US') return -1
    if (b === 'US') return 1
    return a.localeCompare(b)
  })
  const isMultiState = knownStates.size > 1

  return {
    search, setSearch,
    filterStatuses, setFilterStatuses,
    filterPriorities, setFilterPriorities,
    filterPositions, setFilterPositions,
    filterYears, setFilterYears,
    filterStates, setFilterStates,
    filterMinRelevance, setFilterMinRelevance,
    filterSheetOpen, setFilterSheetOpen,
    myBills, setMyBills,
    unvotedOnly, setUnvotedOnly,
    newMatches, setNewMatches,
    selectedTags, setSelectedTags,
    selectedSubjects, subjectGroups,
    cfFilters, setCfFilter,
    currentFilters,
    handleTagClick, handleTagsChange, handleSubjectsChange, handleStatusClick, handlePriorityClick,
    handlePositionClick, handleYearClick, handleRelevanceClick, handleResetFilters,
    yearFacetKeys, statuses, allTags, positionOptions, uniqueStates, isMultiState,
    hasActiveFilters, totalActiveFilters,
    applyView,
    activeViewSlug: searchParams.get('view'),
    clearView: () => {
      pendingViewId.current = null
      pendingViewQuery.current = null
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.delete('view')
        return next
      }, { replace: true })
    },
  }
}
