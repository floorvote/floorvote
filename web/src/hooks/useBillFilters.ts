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

export type ViewLike = { id: string; query: string }

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

  const cfFilters = useMemo(() => {
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
  }, [searchParams, customFieldDefs])

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
    const def = customFieldDefs.find(d => d.id === fieldId)
    const urlKey = `cf_${def?.slug ?? fieldId}`
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      // Remove any existing cf_ params for this field (by slug or id)
      for (const key of [...next.keys()]) {
        if (key.startsWith('cf_')) {
          const s = key.slice(3)
          if (s === fieldId || s === def?.slug) next.delete(key)
        }
      }
      for (const v of values) next.append(urlKey, v)
      return next
    })
  }

  // Set by handleResetFilters so the sync effect below drops the cf_ params
  // instead of preserving them. See the comment on handleResetFilters for why
  // reset cannot just delete them itself.
  const pendingCfReset = useRef(false)
  const [resetNonce, setResetNonce] = useState(0)

  // Tracks whether the currently-applied filters were put there by applying a
  // saved view (via applyView, below, or BillList's cold-load hydration of a
  // bookmarked `?view=<id>`), and if so, which view and what its query
  // normalizes to.
  //   - `undefined` (initial): never interacted with via applyView — a `view`
  //     param already in the URL (a bookmark) is preserved as-is; BillList's
  //     separate stale-slug guard validates it once the /views fetch resolves.
  //   - `null`: explicitly not tracking a view (applyView(null), a filter
  //     edit that diverged from the tracked view, or "Reset filters").
  //   - a view id: tracking that view; the sync effect below collapses the
  //     URL to the short `?view=<id>` form as long as the built query keeps
  //     matching pendingViewQuery, and drops both the moment it stops.
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
    // `view` resolution — must run before the pendingCfReset block below,
    // which consumes that flag; placed after it, "Reset filters" would leave
    // a stale slug (see the pendingViewId ref comment above `resetNonce` for
    // the states this switches on).
    //
    // A `view` param never touched by applyView (pendingViewId still at its
    // initial `undefined`) is a bookmark — preserved as-is, unless a reset
    // just asked for it to go. BillList's separate stale-slug guard is what
    // validates it once the /views fetch resolves.
    if (pendingViewId.current === undefined) {
      const existingView = searchParams.get('view')
      if (existingView && !pendingCfReset.current) next.set('view', existingView)
    } else if (pendingViewId.current !== null) {
      // A view is being tracked: the bookmark stays the short `?view=<id>`
      // form for as long as the filters applied now still match it. cf_
      // params live outside this effect's own params, so they're folded into
      // the comparison from `searchParams` directly (skipped on a pending
      // reset, same as the preservation below).
      const cfEntries: Array<[string, string]> = []
      if (!pendingCfReset.current) {
        for (const [key, value] of searchParams.entries()) {
          if (key.startsWith('cf_')) cfEntries.push([key, value])
        }
      }
      const comparison = new URLSearchParams(next.toString())
      for (const [key, value] of cfEntries) comparison.append(key, value)
      const nextNormalized = normalizeViewQuery('?' + comparison.toString())
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
    // Preserve cf_ params managed outside this effect — unless a reset has just
    // asked for them to go. This effect is the last writer of the query string,
    // so a delete performed anywhere else is resurrected here from the
    // pre-delete `searchParams` and the reset silently does nothing.
    if (pendingCfReset.current) {
      pendingCfReset.current = false
    } else {
      for (const [key, value] of searchParams.entries()) {
        if (key.startsWith('cf_')) {
          next.append(key, value)
        }
      }
    }
    const searchStr = '?' + next.toString()
    lastWrittenSearch.current = searchStr
    setSearchParams(next, { replace: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatuses, filterPriorities, filterPositions, filterYears, filterStates, filterMinRelevance, myBills, unvotedOnly, newMatches, selectedTags, selectedSubjects, sortCol, sortDir, resetNonce])

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

  // Custom fields live in the URL rather than in state, so reset has to clear
  // them there. It defers that to the state→URL sync effect instead of writing
  // the query string itself: the two writers raced, and the effect — which runs
  // in response to the very state changes reset makes — rebuilt the string from
  // the pre-reset params and won, putting every cf_ back. Bumping resetNonce
  // guarantees the effect fires even if every other filter was already empty,
  // rather than leaving that to the identity of the fresh [] literals below.
  const handleResetFilters = useCallback(() => {
    pendingCfReset.current = true
    pendingViewId.current = null
    pendingViewQuery.current = null
    setResetNonce(n => n + 1)
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
  }, [])

  // Applies a saved view's stored query to filter state — used both when the
  // user picks a view from the switcher and when BillList hydrates a
  // bookmarked `?view=<id>` on cold load. Sets filter state and marks the
  // view as tracked (see the pendingViewId ref comment above); it never calls
  // setSearchParams itself for the non-cf_ params, leaving the sync effect
  // above as the sole writer of the query string, per the design doc.
  const applyView = useCallback((view: ViewLike | null) => {
    setSearch('')
    if (!view) {
      handleResetFilters()
      return
    }
    const params = new URLSearchParams(view.query)
    pendingViewId.current = view.id
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
    // cf_ params aren't hook state — they live directly in the URL — so
    // they're written the same way setCfFilter writes them: outside the sync
    // effect, which preserves whatever cf_ params are already present.
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const key of [...next.keys()]) {
        if (key.startsWith('cf_')) next.delete(key)
      }
      for (const [key, value] of params.entries()) {
        if (key.startsWith('cf_')) next.append(key, value)
      }
      return next
    }, { replace: true })
  }, [handleResetFilters, setSearchParams, setSortCol, setSortDir])

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
