import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { useSearchParams } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import type { CustomFieldDef, FacetCounts, SortColumn, SortDir } from '../pages/BillList/types'
import { STATUS_SEMANTIC_ORDER } from '../pages/BillList/constants'
import {
  EMPTY_BILL_FILTER, FILTER_ANY, activeFilterCount, activeFilters as activeFiltersOf, decodeSubjectFilter, encodeSubjectFilter, serializeBillFilter, withBillFilter, type BillFilter,
} from '../../../shared/billFilter'
import { billFilterForUrl, billFilterFromSearch, billsQueryFromSearch, withCustomFieldKeys } from '../pages/BillList/billsQuery'
import { knownStates, knownStatuses, knownTagsCache } from '../pages/BillList'
import { normalizeViewQuery } from '../lib/savedViews'
import { STATUS_STAGES } from '../../../shared/statusStages'

type SearchParams = ReturnType<typeof useSearchParams>[0]
type SetSearchParams = ReturnType<typeof useSearchParams>[1]

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

  // The one bill filter value. Every control, the URL, a saved view, and Reset write it through `commit`, which
  // keeps the value it has when the new one is the same filter, so nothing that depends on it runs for no change.
  const [filter, setFilterState] = useState<BillFilter>(() =>
    withBillFilter({ search: '' }, billFilterFromSearch(searchParams, customFieldDefs)),
  )
  const commit = useCallback((next: BillFilter | ((prev: BillFilter) => BillFilter)) => {
    setFilterState(prev => {
      const value = typeof next === 'function' ? next(prev) : next
      return value === prev || serializeBillFilter(value) === serializeBillFilter(prev) ? prev : value
    })
  }, [])
  const update = useCallback((patch: Partial<BillFilter>) => commit(prev => withBillFilter(patch, prev)), [commit])

  const [filterSheetOpen, setFilterSheetOpen] = useState(false)

  // The URL names a custom field by its slug, but the value holds it by its id. customFieldDefs loads
  // asynchronously and can still be [] when a key is read, in which case the key stays as the URL gave it. The value
  // is not re-derived from the URL on every render, so a key left that way would stay forever. Re-name it here when the
  // defs arrive, keyed only off customFieldDefs (not off the location), so this never becomes a second writer of the
  // query string: the sync effect below stays the sole writer, and this only corrects the value's own keys.
  useEffect(() => {
    if (customFieldDefs.length === 0) return
    commit(prev => withCustomFieldKeys(prev, customFieldDefs, 'id'))
  }, [customFieldDefs, commit])

  const lastWrittenSearch = useRef(location.search)
  useEffect(() => {
    if (location.search === lastWrittenSearch.current) return
    // An edit to the URL replaces the filters, through the same parse as a saved view. The search box is state, not
    // part of the URL, so it keeps what it holds.
    const query = billsQueryFromSearch(new URLSearchParams(location.search), customFieldDefs)
    commit(prev => withBillFilter({ search: prev.search }, query.filter))
    setSortCol(query.sortCol)
    setSortDir(query.sortDir)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  // Each filter by its one name, for the controls that take one list or flag each. These are copies, rebuilt only
  // when their part of the value is a new one, so an effect that depends on one runs when that filter changes. A year
  // is a number and a subject its `STATE:name` text, as the controls take them. Writing goes through the setters
  // below, which write the one value.
  const search = filter.search
  const status = useMemo(() => [...filter.status], [filter.status])
  const stage = useMemo(() => [...filter.stage], [filter.stage])
  const priority = useMemo(() => [...filter.priority], [filter.priority])
  const position = useMemo(() => [...filter.position], [filter.position])
  const year = useMemo(() => filter.year.map(Number).filter(n => !isNaN(n)), [filter.year])
  const state = useMemo(() => [...filter.state], [filter.state])
  const minRelevance = filter.minRelevance ?? 0
  const myBills = filter.myBills
  const unvoted = filter.unvoted
  const newMatches = filter.newMatches
  const drafts = filter.drafts
  const match = filter.match
  const tag = useMemo(() => [...filter.tag], [filter.tag])
  const subject = useMemo(() => filter.subject.map(s => encodeSubjectFilter(s.state, s.name)), [filter.subject])
  const field = useMemo(
    () => Object.fromEntries(Object.entries(filter.field).map(([id, values]) => [id, [...values]])) as Record<string, string[]>,
    [filter.field],
  )

  // A setter takes the new value of its part of the filter, or a function from the part as it stands.
  const part = useCallback(<T,>(read: (f: BillFilter) => T, write: (v: T) => Partial<BillFilter>) =>
    (next: T | ((prev: T) => T)) =>
      commit(prev => withBillFilter(write(typeof next === 'function' ? (next as (p: T) => T)(read(prev)) : next), prev)),
  [commit])
  const setSearch = useMemo(() => part<string>(f => f.search, search => ({ search })), [part])
  const setStatus = useMemo(() => part<string[]>(f => [...f.status], status => ({ status })), [part])
  const setStage = useMemo(() => part<string[]>(f => [...f.stage], stage => ({ stage })), [part])
  const setPriority = useMemo(() => part<string[]>(f => [...f.priority], priority => ({ priority })), [part])
  const setPosition = useMemo(() => part<string[]>(f => [...f.position], position => ({ position })), [part])
  const setYear = useMemo(
    () => part<number[]>(f => f.year.map(Number).filter(n => !isNaN(n)), years => ({ year: years.map(String) })), [part])
  const setState = useMemo(() => part<string[]>(f => [...f.state], state => ({ state })), [part])
  const setMinRelevance = useMemo(
    () => part<number>(f => f.minRelevance ?? 0, n => ({ minRelevance: n > 0 ? n : null })), [part])
  const setMyBills = useMemo(() => part<boolean>(f => f.myBills, myBills => ({ myBills })), [part])
  const setUnvoted = useMemo(() => part<boolean>(f => f.unvoted, unvoted => ({ unvoted })), [part])
  const setNewMatches = useMemo(() => part<boolean>(f => f.newMatches, newMatches => ({ newMatches })), [part])
  const setDrafts = useMemo(() => part<boolean>(f => f.drafts, drafts => ({ drafts })), [part])
  const setMatch = useMemo(() => part<BillFilter['match']>(f => f.match, match => ({ match })), [part])
  const setTag = useMemo(() => part<string[]>(f => [...f.tag], tag => ({ tag })), [part])

  const setField = useCallback((fieldId: string, values: string[]) => {
    commit(prev => {
      const rest = Object.fromEntries(Object.entries(prev.field).filter(([id]) => id !== fieldId))
      return withBillFilter({ field: Object.freeze(values.length > 0 ? { ...rest, [fieldId]: Object.freeze([...values]) } : rest) }, prev)
    })
  }, [commit])

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

  // The URL's filter part: the value written with the shared serialize, a custom field by its slug and the search
  // box left out. As a string, so typing in the search box (which changes the value, not this) writes nothing.
  const urlQuery = serializeBillFilter(billFilterForUrl(filter, customFieldDefs))

  useEffect(() => {
    const next = new URLSearchParams(urlQuery)
    if (sortCol !== 'default') {
      next.set('sort', sortCol)
      next.set('dir', sortDir)
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
      // form for as long as the filters applied now — custom fields included, from
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
  }, [urlQuery, sortCol, sortDir])

  const handleTagClick = useCallback((tag: string) => {
    commit(prev => withBillFilter({ tag: prev.tag.includes(tag) ? prev.tag.filter(t => t !== tag) : [...prev.tag, tag] }, prev))
  }, [commit])

  const handleTagsChange = useCallback((tags: string[]) => update({ tag: tags }), [update])

  const handleSubjectsChange = useCallback((next: string[]) => {
    update({ subject: next.flatMap(v => decodeSubjectFilter(v) ?? []) })
  }, [update])

  const handleStatusClick = useCallback((status: string) => {
    commit(prev => withBillFilter({ status: prev.status.includes(status) ? prev.status.filter(s => s !== status) : [...prev.status, status] }, prev))
  }, [commit])

  const handlePriorityClick = useCallback((priority: string) => {
    commit(prev => withBillFilter({ priority: prev.priority.includes(priority) ? prev.priority.filter(p => p !== priority) : [...prev.priority, priority] }, prev))
  }, [commit])

  const handlePositionClick = useCallback((position: string) => {
    commit(prev => withBillFilter({ position: prev.position.includes(position) ? prev.position.filter(p => p !== position) : [...prev.position, position] }, prev))
  }, [commit])

  const handleYearClick = useCallback((year: number) => {
    const key = String(year)
    commit(prev => withBillFilter({ year: prev.year.includes(key) ? prev.year.filter(y => y !== key) : [...prev.year, key] }, prev))
  }, [commit])

  const handleRelevanceClick = useCallback((score: number) => {
    commit(prev => withBillFilter({ minRelevance: prev.minRelevance === score ? null : score }, prev))
  }, [commit])

  // Reset sets the empty bill filter, so every filter goes at once, the search box and custom fields included.
  const handleResetFilters = useCallback(() => {
    pendingViewId.current = null
    pendingViewQuery.current = null
    commit(EMPTY_BILL_FILTER)
  }, [commit])

  // Applies a saved view's stored query to the filter value — used both when the
  // user picks a view from the switcher and when BillList hydrates a
  // bookmarked `?view=<id>` on cold load. Parses the view's query with the same
  // read as a URL edit, and marks the view as tracked (see the pendingViewId ref
  // comment above); it never calls setSearchParams itself, leaving the sync
  // effect above as the sole writer of the query string, per the design doc.
  const applyView = useCallback((view: ViewLike | null) => {
    if (!view) {
      handleResetFilters()
      return
    }
    // Prefer the slug for the URL — falling back to the id only covers a view
    // that predates the slug backfill reaching it (the /views response should
    // always carry one by the time this runs, but the fallback keeps this
    // safe rather than writing `?view=undefined`).
    pendingViewId.current = view.slug ?? view.id
    pendingViewQuery.current = normalizeViewQuery(view.query)
    const query = billsQueryFromSearch(new URLSearchParams(view.query), customFieldDefs)
    commit(withBillFilter({ search: '' }, query.filter))
    setSortCol(query.sortCol)
    setSortDir(query.sortDir)
  }, [customFieldDefs, handleResetFilters, commit, setSortCol, setSortDir])

  // The one list of active filters. Reset's gate and the badge's count are read from it, as are the chips, the filter
  // sheet, and the split pane's summary elsewhere, so none of them counts for itself.
  const activeFilters = useMemo(() => activeFiltersOf(filter), [filter])
  const hasActiveFilters = activeFilters.length > 0
  const totalActiveFilters = activeFilterCount(activeFilters)

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
  // Every stage, most advanced first like the statuses above. The list is
  // fixed, so a stage with no bills still shows, at 0.
  const stageOptions = useMemo(
    () => [...STATUS_STAGES].reverse().map(s => ({ value: s.key as string, label: s.label as string })),
    [],
  )
  // Options come from the facets API + the session-sticky knownTagsCache, but a tag removed
  // from the taxonomy must never be selectable. Intersect with the taxonomy; fail open (show all)
  // while the taxonomy is still loading, so options never briefly vanish.
  const allTags = useMemo(() => {
    const taxonomySet = new Set(tagTaxonomy)
    return [...new Set([...knownTagsCache, ...Object.keys(facetCounts.tag)])]
      .filter(t => t !== FILTER_ANY && (taxonomySet.size === 0 || taxonomySet.has(t)))
      .sort()
  }, [facetCounts.tag, tagTaxonomy])
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
    for (const [value, count] of Object.entries(facetCounts.subject ?? {})) {
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
  }, [facetCounts.subject])

  const uniqueStates = [...new Set([...knownStates, ...Object.keys(facetCounts.state)])].sort((a, b) => {
    if (a === 'US') return -1
    if (b === 'US') return 1
    return a.localeCompare(b)
  })
  const isMultiState = knownStates.size > 1

  return {
    search, setSearch,
    status, setStatus,
    stage, setStage,
    priority, setPriority,
    position, setPosition,
    year, setYear,
    state, setState,
    minRelevance, setMinRelevance,
    filterSheetOpen, setFilterSheetOpen,
    myBills, setMyBills,
    unvoted, setUnvoted,
    newMatches, setNewMatches,
    drafts, setDrafts,
    match, setMatch,
    tag, setTag,
    subject, subjectGroups,
    field, setField,
    filter,
    handleTagClick, handleTagsChange, handleSubjectsChange, handleStatusClick, handlePriorityClick,
    handlePositionClick, handleYearClick, handleRelevanceClick, handleResetFilters,
    yearFacetKeys, statuses, stageOptions, allTags, positionOptions, uniqueStates, isMultiState,
    activeFilters, hasActiveFilters, totalActiveFilters,
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
