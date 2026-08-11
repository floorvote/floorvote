import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import React from 'react'
import { useLocation, useNavigate, useSearchParams, type LoaderFunctionArgs } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { BulkActionBar } from '../../components/BulkActionBar'
import { apiFetch } from '../../lib/api'
import { decodeStatus } from '../../lib/legislativeStatus'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useAuth } from '../../hooks/useAuth'
import { useScrolledUnder } from '../../hooks/useScrolledUnder'
import { FilterSheet } from '../../components/FilterSheet'
import { HoverTooltip } from '../../components/HoverTooltip'
import { useSidebarRefresh } from '../../context/SidebarRefreshContext'
import { CARD } from '../../lib/cardStyle'
import { PRIORITY_COLORS, POSITION_COLORS, POSITION_FALLBACK, COUNT_BADGE } from '../../lib/chipStyles'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { billUrl } from '../../lib/sessionSlug'
import { orgPositionLabel, DEFAULT_ORG_NOUN } from '../../lib/orgNoun'
import { BillRow } from './BillRow'
import { FilterDropdown, ActiveChip, SortHeader, sortDescription, FILTER_ANY } from './FilterPanel'
import { PAGE_SIZE, OUTER_GRID, CHIP_GRID, CHIP_GRID_MULTISTATE, CHIP_GAP } from './constants'
import type { Bill, CustomFieldDef, FacetCounts, NormalizedSession } from './types'
import { useBillSort } from '../../hooks/useBillSort'
import { useBillFilters } from '../../hooks/useBillFilters'
import { useBulkActions } from '../../hooks/useBulkActions'
import { useDemo } from '../../context/DemoContext'
import { billsApiParams, billsFilterValuesFromSearch } from './billsQuery'
import { searchWarnings } from '../../../../shared/searchLimits'

// Module-level cache for instant render when returning from BillDetail
type BillsListPage = { bills: Bill[]; total: number; totalPages: number }
let billsListCache: { params: string; page: BillsListPage } | null = null
let cachedCustomFieldDefs: CustomFieldDef[] | null = null
let cachedFacetCounts: FacetCounts | null = null
export const knownStates: Set<string> = new Set()
export const knownSessions: Set<string> = new Set()
export const knownStatuses: Set<string> = new Set()
export const knownTagsCache: Set<string> = new Set()

export async function prefetchBills(targetUrl: string): Promise<void> {
  const search = new URLSearchParams(targetUrl.includes('?') ? targetUrl.slice(targetUrl.indexOf('?') + 1) : '')
  const paramsStr = billsApiParams(billsFilterValuesFromSearch(search), 1, PAGE_SIZE)
  const data = await apiFetch<{ bills: Bill[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/bills?${paramsStr}`)
  billsListCache = { params: paramsStr, page: { bills: data.bills, total: data.pagination.total, totalPages: data.pagination.totalPages } }
}

// Route loader: warm billsListCache for the current URL before the list renders
// (RR7 data router), so the component's hitCache path paints instantly. Same fetch,
// same cache-then-background-refresh behavior. Swallows fetch errors so a transient
// failure degrades to the component's own in-list error state rather than an error
// page. (prefetchBills is the loader's cache-warmer; no longer called from the
// sidebar, which now uses plain router navigation.)
export async function billListLoader({ request }: LoaderFunctionArgs): Promise<null> {
  try {
    await prefetchBills(request.url)
  } catch {
    // component's fetchBills will retry and surface the error
  }
  return null
}

// Accumulate known values from every facet response so bounded filters show 0-count options instead of disappearing
export function updateKnownStates(counts: FacetCounts) {
  Object.keys(counts.state).forEach(s => knownStates.add(s))
  Object.keys(counts.session).forEach(s => knownSessions.add(s))
  Object.keys(counts.status).forEach(s => knownStatuses.add(s))
  Object.keys(counts.tags).forEach(t => knownTagsCache.add(t))
}

export function BillList() {
  usePageTitle('Bills')
  const { demoLocked } = useDemo()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [allBills, setAllBills] = useState<Bill[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [facetCounts, setFacetCounts] = useState<FacetCounts>(() => {
    const initial = cachedFacetCounts ?? { status: {}, priority: {}, session: {}, year: {}, state: {}, position: {}, tags: {}, customFields: {}, myBillsCount: 0, newMatchesCount: 0 }
    if (cachedFacetCounts) updateKnownStates(cachedFacetCounts)
    return initial
  })

  const [positionVocabulary, setPositionVocabulary] = useState<string[]>(['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'])
  const [tagTaxonomy, setTagTaxonomy] = useState<string[]>([])
  const [orgNoun, setOrgNoun] = useState<string>(DEFAULT_ORG_NOUN)
  const [loading, setLoading] = useState(true)   // initial mount only
  const [refreshing, setRefreshing] = useState(false) // subsequent fetches
  const [error, setError] = useState<string | null>(null)

  const hasFetchedOnce = useRef(false)
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDef[]>(cachedCustomFieldDefs ?? [])

  const { user } = useAuth()
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  const refreshSidebar = useSidebarRefresh()

  // --- sort (hook) ---
  const { sortCol, sortDir, setSortCol, setSortDir, handleSort, handleReset } = useBillSort(searchParams)

  // --- filters + URL sync + derived lists (hook) ---
  const f = useBillFilters({
    searchParams, setSearchParams, location, facetCounts, customFieldDefs, positionVocabulary, tagTaxonomy,
    sortCol, sortDir, setSortCol, setSortDir,
  })
  const searchWarn = searchWarnings(f.search)

  // Relevance slider: track the thumb locally so it moves instantly while
  // dragging, but only commit the value (which drives the URL + bill query) on
  // release. This fires exactly one fetch per interaction regardless of drag
  // speed, instead of one per step. Stays in sync when the value changes
  // elsewhere (URL nav, reset).
  const [relevanceDraft, setRelevanceDraft] = useState(f.filterMinRelevance)
  useEffect(() => { setRelevanceDraft(f.filterMinRelevance) }, [f.filterMinRelevance])
  const commitRelevance = () => {
    if (relevanceDraft !== f.filterMinRelevance) f.setFilterMinRelevance(relevanceDraft)
  }

  // Stable ref so handleVote doesn't close over allBills state
  const allBillsRef = useRef<Bill[]>([])
  useEffect(() => { allBillsRef.current = allBills }, [allBills])

  // Scroll container for virtualizer — main element owns page scroll
  const scrollRef = useRef<HTMLElement | null>(null)
  useEffect(() => { scrollRef.current = document.querySelector('main') }, [])
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const sortedRef = useRef<Bill[]>([])
  // Pinned-header drop shadow: shown once the page (`<main>`) has scrolled under it.
  const headerScrolled = useScrolledUnder(() => document.querySelector('main'))

  // --- bulk selection (hook) ---
  const { selection, isSelectionMode, handleToggleSelect, handleSelectAllFilters, handleClearSelection } = useBulkActions({
    sortedRef,
    resetDeps: [f.filterStatuses, f.filterPriorities, f.filterPositions, f.filterYears, f.filterStates, f.filterMinRelevance, f.myBills, f.unvotedOnly, f.newMatches, f.selectedTags, f.search, sortCol, sortDir],
  })

  const fetchBills = useCallback(async (nextPage: number, append: boolean) => {
    const paramsStr = billsApiParams({
      statuses: f.filterStatuses, priorities: f.filterPriorities, positions: f.filterPositions,
      years: f.filterYears, states: f.filterStates, minRelevance: f.filterMinRelevance,
      myBills: f.myBills, unvoted: f.unvotedOnly, newMatches: f.newMatches,
      tags: f.selectedTags, search: f.search, sortCol, sortDir, cfFilters: f.cfFilters,
    }, nextPage, PAGE_SIZE)
    const hitCache = nextPage === 1 && !append && !hasFetchedOnce.current && billsListCache?.params === paramsStr
    if (hitCache) {
      setAllBills(billsListCache!.page.bills)
      setTotal(billsListCache!.page.total)
      setHasMore(1 < billsListCache!.page.totalPages)
      setPage(1)
      hasFetchedOnce.current = true
      setLoading(false)
      setRefreshing(true)
    } else if (nextPage === 1 && !append && !hasFetchedOnce.current) {
      setLoading(true)
    } else {
      setRefreshing(true)
    }
    try {
      const data = await apiFetch<{ bills: Bill[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/bills?${paramsStr}`)
      if (nextPage === 1 && !append) {
        billsListCache = { params: paramsStr, page: { bills: data.bills, total: data.pagination.total, totalPages: data.pagination.totalPages } }
      }
      if (append) {
        setAllBills(prev => [...prev, ...data.bills])
      } else {
        setAllBills(data.bills)
      }
      hasFetchedOnce.current = true
      setTotal(data.pagination.total)
      setHasMore(nextPage < data.pagination.totalPages)
      setPage(nextPage)
    } catch {
      setError('Failed to load bills.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [f.filterStatuses, f.filterPriorities, f.filterPositions, f.filterYears, f.filterStates, f.filterMinRelevance, f.myBills, f.unvotedOnly, f.newMatches, f.selectedTags, f.search, sortCol, sortDir, f.cfFilters])

  const fetchFacets = useCallback(async () => {
    const params = new URLSearchParams()
    if (f.filterStatuses.length > 0) f.filterStatuses.forEach(s => params.append('status', s))
    if (f.filterPriorities.length > 0) f.filterPriorities.forEach(p => params.append('priority', p))
    if (f.filterPositions.length > 0) f.filterPositions.forEach(p => params.append('position', p))
    if (f.filterYears.length > 0) f.filterYears.forEach(y => params.append('year', String(y)))
    if (f.filterStates.length > 0) f.filterStates.forEach(s => params.append('state', s))
    if (f.filterMinRelevance > 0) params.set('minRelevance', String(f.filterMinRelevance))
    if (f.myBills) params.set('myBills', '1')
    if (f.unvotedOnly) params.set('unvoted', '1')
    if (f.newMatches) params.set('newMatches', '1')
    f.selectedTags.forEach(t => params.append('tag', t))
    if (f.search) params.set('q', f.search)
    for (const [key, values] of Object.entries(f.cfFilters)) {
      values.forEach(v => params.append(`cf_${key}`, v))
    }
    try {
      const data = await apiFetch<FacetCounts>(`/bills/facets?${params}`)
      cachedFacetCounts = data
      updateKnownStates(data)
      setFacetCounts(data)
    } catch {
      // non-fatal — leave previous counts in place
    }
  }, [f.filterStatuses, f.filterPriorities, f.filterPositions, f.filterYears, f.filterStates, f.filterMinRelevance, f.myBills, f.unvotedOnly, f.newMatches, f.selectedTags, f.search, f.cfFilters])

  // Infinite scroll — fire next page fetch when the sentinel enters the viewport
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !refreshing && !loading) {
          fetchBills(page + 1, true)
        }
      },
      { rootMargin: '1200px' }, // prefetch the next page well before the sentinel is visible
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, refreshing, loading, page, fetchBills])

  // Load config and my-bills on mount (once)
  useEffect(() => {
    const y: number | undefined = history.state?.billsScroll

    Promise.all([
      apiFetch<{
        positionVocabulary: string[]
        orgNoun: string
        tagTaxonomy?: string[]
        sessions?: NormalizedSession[]
      }>('/config'),
      apiFetch<{ id: string }[]>('/users/me/bills'),
      apiFetch<CustomFieldDef[]>('/config/custom-fields'),
    ])
      .then(([cfg, _myBillsData, cfDefs]) => {
        setPositionVocabulary(cfg.positionVocabulary)
        setTagTaxonomy(cfg.tagTaxonomy ?? [])
        setOrgNoun(cfg.orgNoun ?? DEFAULT_ORG_NOUN)
        cachedCustomFieldDefs = cfDefs
        setCustomFieldDefs(cfDefs)
        if (y != null) {
          requestAnimationFrame(() => {
            const main = document.querySelector('main')
            if (main) main.scrollTop = y
          })
        }
      })
      .catch(() => setError('Failed to load bills.'))
  }, [])

  // Fetch bills + facets whenever filters/sort change (search debounced). The
  // relevance slider commits its value only on release (see relevanceDraft), so
  // a drag produces a single filterMinRelevance change and one fetch here.
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevSearchRef = useRef(f.search)
  useEffect(() => {
    if (f.search !== prevSearchRef.current) {
      prevSearchRef.current = f.search
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
      searchDebounceRef.current = setTimeout(() => {
        fetchBills(1, false)
        fetchFacets()
      }, 300)
      return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current) }
    }
    fetchBills(1, false)
    fetchFacets()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchBills, fetchFacets])

  useEffect(() => {
    function onVoteChanged(e: Event) {
      const { billId, newVote, prevVote } = (e as CustomEvent).detail
      setAllBills(prev => prev.map(b => {
        if (b.id !== billId) return b
        const vc = { ...b.voteCounts }
        if (prevVote) vc[prevVote as keyof typeof vc] = Math.max(0, vc[prevVote as keyof typeof vc] - 1)
        if (newVote) vc[newVote as keyof typeof vc] = vc[newVote as keyof typeof vc] + 1
        return { ...b, myVote: newVote ?? null, voteCounts: vc }
      }))
    }
    window.addEventListener('bill-vote-changed', onVoteChanged)
    return () => window.removeEventListener('bill-vote-changed', onVoteChanged)
  }, [])

  useEffect(() => {
    sessionStorage.setItem('lastBillsUrl', location.pathname + location.search)
  }, [location.pathname, location.search])

  const navigate = useNavigate()

  const handleBillNavigate = useCallback((_billId: string, path: string, navState: { billPaths: string[]; currentIndex: number }) => {
    // The bill route's loader fetches the destination bill and the router holds
    // this list in place until it resolves; `navState` carries prev/next list
    // context (no longer prefetched bill data).
    navigate(path, { state: navState })
  }, [navigate])

  const handlePriorityChange = useCallback((billId: string, priority: 'high' | 'medium' | 'low' | null) => {
    setAllBills(prev => prev.map(b => b.id === billId ? { ...b, priority } : b))
    refreshSidebar()
  }, [refreshSidebar])

  const handleVote = useCallback(async (billId: string, pos: 'support' | 'neutral' | 'oppose') => {
    if (demoLocked) return
    const bill = allBillsRef.current.find(b => b.id === billId)
    if (!bill) return
    const prevVote = bill.myVote
    const prevCounts = bill.voteCounts
    const isToggle = prevVote === pos
    setAllBills(prev => prev.map(b => {
      if (b.id !== billId) return b
      const vc = { ...b.voteCounts }
      if (isToggle) { vc[pos] = Math.max(0, vc[pos] - 1) }
      else {
        if (prevVote) vc[prevVote as keyof typeof vc] = Math.max(0, vc[prevVote as keyof typeof vc] - 1)
        vc[pos] = vc[pos] + 1
      }
      return { ...b, myVote: isToggle ? null : pos, voteCounts: vc }
    }))
    try {
      if (isToggle) {
        await apiFetch(`/bills/${billId}/votes`, { method: 'DELETE' })
      } else {
        await apiFetch(`/bills/${billId}/votes`, { method: 'POST', body: JSON.stringify({ position: pos }) })
      }
    } catch {
      // Revert the optimistic update so a failed vote doesn't linger as if saved.
      setAllBills(prev => prev.map(b => b.id === billId ? { ...b, myVote: prevVote, voteCounts: prevCounts } : b))
      return
    }
    refreshSidebar()
  }, [refreshSidebar, demoLocked])

  const handlePositionChange = useCallback((billId: string, position: string | null) => {
    setAllBills(prev => prev.map(b => b.id === billId ? { ...b, position } : b))
  }, [])

  // Triage dismiss already hit the API in NewMatchTriageControl. Mark the bill
  // dismissed locally so the row's triage control reverts to a plain priority
  // select, and refresh facets so the "New matches" count drops.
  const handleTriageDismiss = useCallback((billId: string) => {
    setAllBills(prev => prev.map(b => b.id === billId ? { ...b, triagedAt: new Date().toISOString() } : b))
    fetchFacets()
  }, [fetchFacets])

  const selectedBills = useMemo(() => {
    if (selection.mode !== 'ids') return []
    return allBills.filter(b => selection.ids.has(b.id)).map(b => ({
      id: b.id,
      priority: b.priority ?? null,
      matchType: b.matchType ?? null,
      position: b.position ?? null,
      customFieldValues: b.customFieldValues ?? {},
      newMatchAt: b.newMatchAt ?? null,
      triagedAt: b.triagedAt ?? null,
    }))
  }, [selection, allBills])

  const handleBulkApplied = useCallback((
    updatedIds: string[] | 'filter',
    updates: {
      priority?: 'high' | 'medium' | 'low' | null
      position?: string | null
      customFields?: Array<
        | { fieldId: string; value: string | null }
        | { fieldId: string; additions: string[]; removals: string[] }
      >
      triagedAt?: string | null
    },
  ) => {
    if (updatedIds === 'filter') {
      billsListCache = null
      void fetchBills(1, false)
      void fetchFacets()
      return
    }
    const idSet = new Set(updatedIds)
    setAllBills(prev => prev.map(b => {
      if (!idSet.has(b.id)) return b
      const next = { ...b }
      if ('priority' in updates) next.priority = updates.priority ?? null
      if ('position' in updates) next.position = updates.position ?? null
      if (updates.triagedAt !== undefined) next.triagedAt = updates.triagedAt
      if (updates.customFields) {
        const cfv = { ...(b.customFieldValues ?? {}) }
        for (const entry of updates.customFields) {
          const fieldId = entry.fieldId
          if ('additions' in entry || 'removals' in entry) {
            const multiEntry = entry as { fieldId: string; additions?: string[]; removals?: string[] }
            // Multi-select update: union with additions, remove removals
            const current = (() => {
              const raw = cfv[fieldId]
              if (!raw) return [] as string[]
              try {
                const p = JSON.parse(raw)
                return Array.isArray(p) ? (p as string[]) : [raw]
              } catch {
                return [raw]
              }
            })()
            const additions = multiEntry.additions ?? []
            const removals = new Set(multiEntry.removals ?? [])
            const merged: string[] = []
            for (const v of current) if (!removals.has(v) && !merged.includes(v)) merged.push(v)
            for (const v of additions) if (!removals.has(v) && !merged.includes(v)) merged.push(v)
            if (merged.length === 0) delete cfv[fieldId]
            else cfv[fieldId] = JSON.stringify(merged)
          } else {
            const singleEntry = entry as { fieldId: string; value: string | null }
            if (singleEntry.value === null) delete cfv[fieldId]
            else cfv[fieldId] = singleEntry.value
          }
        }
        next.customFieldValues = cfv
      }
      return next
    }))
    refreshSidebar()
  }, [fetchBills, fetchFacets, refreshSidebar])

  const filterCounts = facetCounts

  // Server handles sorting; use allBills directly as the display list
  const sorted = allBills
  sortedRef.current = sorted
  const sortedPaths = useMemo(
    () => sorted.map(b => billUrl({ id: b.id, state: b.state, session: b.session, billNumber: b.billNumber })),
    [sorted]
  )

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 150,
    overscan: 5,
  })

  if (loading) return <div style={{ padding: 32, color: color.textMuted }}>Loading…</div>
  if (error) return <div style={{ padding: 32, color: color.textErrorRed }}>{error}</div>

  return (
    <>
      {/* Full-width sticky block: filter controls + column headers */}
      <div className="bill-list-sticky-header" style={{ position: 'sticky', top: 0, zIndex: 10, background: color.surfaceMuted }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
        <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, margin: 0 }}>Bills</h1>
      </div>

      {/* Search warnings — above the box so they don't collide with the filter
          chips/dropdowns below. Composed from searchWarnings() (0, 1, or 2 lines). */}
      {searchWarn.length > 0 && (
        <div style={{ fontSize: fontSize.xs, color: color.textAmberWarning, marginBottom: 6 }}>
          {searchWarn.join(' ')}
        </div>
      )}
      {/* Filter bar — order matches table columns: Status, Relevance, Positions, Priority, Tags */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6, alignItems: 'center' }}>
        <HoverTooltip
          maxWidth={400}
          placement="right"
          text={
            <>
              Searches bill number, title, and summary.
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                <li>Quotes match an exact phrase (e.g., <i>"voting rights act"</i>).</li>
                <li>Spaces act as ANDs — every word must match (e.g., <i>ballot military overseas</i> finds bills mentioning all three).</li>
                <li>Commas act as ORs (e.g., <i>A9699, S9143</i> finds both bills).</li>
              </ul>
            </>
          }
        >
          <input
            placeholder="Search…"
            value={f.search}
            onChange={(e) => f.setSearch(e.target.value)}
            style={{ fontSize: fontSize.sm, padding: '6px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, minWidth: 200 }}
          />
        </HoverTooltip>
        {/* Mobile filter button — hidden on desktop via CSS */}
        <button
          className="mobile-filter-btn"
          onClick={() => f.setFilterSheetOpen(true)}
          style={{
            fontSize: fontSize.sm,
            padding: '6px 12px',
            borderRadius: radius.md,
            border: '1px solid',
            cursor: 'pointer',
            alignItems: 'center',
            gap: 6,
            background: f.totalActiveFilters > 0 ? color.bgInfo : color.white,
            color: f.totalActiveFilters > 0 ? color.linkBlue : color.textSlate,
            borderColor: f.totalActiveFilters > 0 ? color.tagBorderBlue : color.borderDefault,
            fontWeight: f.totalActiveFilters > 0 ? fontWeight.medium : fontWeight.normal,
          }}
        >
          Filters
          {f.totalActiveFilters > 0 && (
            <span style={{
              background: color.linkBlue, color: color.white,
              borderRadius: radius.lg, padding: '0 6px', fontSize: fontSize.xs, fontWeight: fontWeight.bold,
            }}>
              {f.totalActiveFilters}
            </span>
          )}
        </button>
        {/* Desktop filter dropdowns — hidden on mobile via CSS */}
        <div className="desktop-filter-dropdowns">
          {f.uniqueStates.length > 0 && (
            <HoverTooltip text="Filter by state">
              <FilterDropdown
                placeholder="State"
                options={f.uniqueStates.map(s => ({ value: s }))}
                selected={f.filterStates}
                onChange={f.setFilterStates}
                multi
                counts={filterCounts.state}
              />
            </HoverTooltip>
          )}
          <HoverTooltip text="Show only bills you've voted on, commented on, or noted">
            <button
              onClick={() => f.setMyBills(v => !v)}
              style={{
                fontSize: fontSize.sm,
                padding: '6px 12px',
                borderRadius: radius.md,
                border: `1px solid ${f.myBills ? color.tagBorderBlue : color.borderDefault}`,
                background: f.myBills ? color.bgInfo : color.white,
                color: f.myBills ? color.linkBlue : color.textSlate,
                fontWeight: f.myBills ? fontWeight.medium : fontWeight.normal,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              My Bills
              <span style={{ ...COUNT_BADGE, marginLeft: 4 }}>{filterCounts.myBillsCount.toLocaleString()}</span>
            </button>
          </HoverTooltip>
          {isAdmin && (
            <HoverTooltip text="Newly keyword-matched bills awaiting a priority decision">
              <button
                onClick={() => f.setNewMatches(v => !v)}
                style={{
                  fontSize: fontSize.sm,
                  padding: '6px 12px',
                  borderRadius: radius.md,
                  border: `1px solid ${f.newMatches ? color.tagBorderBlue : color.borderDefault}`,
                  background: f.newMatches ? color.bgInfo : color.white,
                  color: f.newMatches ? color.linkBlue : color.textSlate,
                  fontWeight: f.newMatches ? fontWeight.medium : fontWeight.normal,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                New matches
                <span style={{ ...COUNT_BADGE, marginLeft: 4 }}>{filterCounts.newMatchesCount.toLocaleString()}</span>
              </button>
            </HoverTooltip>
          )}
          <HoverTooltip text="Filter by current legislative status">
            <FilterDropdown
              placeholder="Status"
              options={f.statuses.map(s => ({ value: s, label: decodeStatus(s) ?? s }))}
              selected={f.filterStatuses}
              onChange={f.setFilterStatuses}
              multi
              counts={filterCounts.status}
            />
          </HoverTooltip>
          {f.yearFacetKeys.length > 0 && (
            <HoverTooltip text="Filter by legislative session year">
              <FilterDropdown
                placeholder="Session year"
                options={f.yearFacetKeys.map(y => ({ value: y }))}
                selected={f.filterYears.map(String)}
                onChange={v => f.setFilterYears(v.map(Number).filter(n => !isNaN(n)))}
                multi
                counts={facetCounts.year}
              />
            </HoverTooltip>
          )}
          <HoverTooltip text={`Filter by AI-scored relevance to your ${orgNoun}`}>
            <>
              <style>{`
                input[type=range].relevance-slider { -webkit-appearance: none; appearance: none; background: transparent; height: 14px; }
                input[type=range].relevance-slider::-webkit-slider-runnable-track {
                  background: linear-gradient(to right, ${color.accentAmber} 0%, ${color.accentAmber} ${(relevanceDraft / 10) * 100}%, ${color.borderDefault} ${(relevanceDraft / 10) * 100}%, ${color.borderDefault} 100%);
                  height: 4px; border-radius: 4px;
                }
                input[type=range].relevance-slider::-webkit-slider-thumb {
                  -webkit-appearance: none; width: 14px; height: 14px; background: ${color.accentAmber};
                  border-radius: 50%; margin-top: -5px; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                }
                input[type=range].relevance-slider::-moz-range-track { background: ${color.borderDefault}; height: 4px; border-radius: 4px; }
                input[type=range].relevance-slider::-moz-range-progress { background: ${color.accentAmber}; height: 4px; border-radius: 4px 0 0 4px; }
                input[type=range].relevance-slider::-moz-range-thumb { background: ${color.accentAmber}; border-radius: 50%; width: 14px; height: 14px; border: none; cursor: pointer; }
              `}</style>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: relevanceDraft > 0 ? color.bgInfo : color.white,
                border: `1px solid ${relevanceDraft > 0 ? color.tagBorderBlue : color.borderDefault}`,
                borderRadius: radius.md, padding: '6px 10px',
              }}>
                <label style={{ fontSize: fontSize.sm, whiteSpace: 'nowrap', color: relevanceDraft > 0 ? color.linkBlue : color.textSlate, fontWeight: relevanceDraft > 0 ? fontWeight.medium : fontWeight.normal }}>
                  Relevance: <span style={{ display: 'inline-block', width: 26, textAlign: 'left' }}>{relevanceDraft === 0 ? 'All' : relevanceDraft < 10 ? `${relevanceDraft}+` : '10'}</span>
                </label>
                <input
                  type="range"
                  className="relevance-slider"
                  min={0}
                  max={10}
                  value={relevanceDraft}
                  onChange={(e) => setRelevanceDraft(Number(e.target.value))}
                  onPointerUp={commitRelevance}
                  onKeyUp={commitRelevance}
                  style={{ width: 80 }}
                />
              </div>
            </>
          </HoverTooltip>
          <HoverTooltip text={`Filter by your ${orgNoun}'s official position`}>
            <FilterDropdown
              placeholder="Position"
              options={f.positionOptions}
              selected={f.filterPositions}
              onChange={f.setFilterPositions}
              multi
              counts={filterCounts.position}
              anyIsFilter
            />
          </HoverTooltip>
          <HoverTooltip text={`Filter by your ${orgNoun}'s priority level`}>
            <FilterDropdown
              placeholder="Priority"
              options={[
                { value: 'high', label: 'High Priority' },
                { value: 'medium', label: 'Medium Priority' },
                { value: 'low', label: 'Low Priority' },
                { value: 'none', label: 'Not set' },
              ]}
              selected={f.filterPriorities}
              onChange={f.setFilterPriorities}
              multi
              counts={filterCounts.priority}
              anyIsFilter
            />
          </HoverTooltip>
          {f.allTags.length > 0 && (
            <HoverTooltip text="Filter by topic tags">
              <FilterDropdown
                placeholder="Tag"
                options={f.allTags.map(t => ({ value: t }))}
                selected={f.selectedTags}
                onChange={f.handleTagsChange}
                multi
                counts={filterCounts.tags}
                anyIsFilter
              />
            </HoverTooltip>
          )}
          {/* Custom field filters — binary and dropdown only */}
          {customFieldDefs
            .filter(field => field.type === 'binary' || field.type === 'dropdown')
            .map(field => {
              const selectedValues = f.cfFilters[field.id] ?? []
              if (field.type === 'binary') {
                const isActive = selectedValues.includes('1')
                return (
                  <button
                    key={field.id}
                    onClick={() => f.setCfFilter(field.id, isActive ? [] : ['1'])}
                    style={{
                      fontSize: fontSize.sm, padding: '6px 10px', borderRadius: radius.md, cursor: 'pointer',
                      whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4,
                      background: isActive ? color.bgInfo : color.white,
                      color: isActive ? color.linkBlue : color.textSlate,
                      border: `1px solid ${isActive ? color.tagBorderBlue : color.borderDefault}`,
                      fontWeight: isActive ? fontWeight.medium : fontWeight.normal,
                    }}
                  >
                    {field.name}{isActive ? ' ✓' : ''}
                    <span style={{ ...COUNT_BADGE, marginLeft: 4 }}>{(filterCounts.customFields[field.id]?.['1'] ?? 0).toLocaleString()}</span>
                  </button>
                )
              }
              // Dropdown — reuse FilterDropdown
              const opts: string[] = field.options ?? []
              return (
                <FilterDropdown
                  key={field.id}
                  placeholder={field.name}
                  options={opts.map(o => ({ value: o }))}
                  selected={selectedValues}
                  onChange={v => f.setCfFilter(field.id, v)}
                  multi
                  counts={filterCounts.customFields[field.id] ?? {}}
                  anyIsFilter
                />
              )
            })
          }
        </div>
      </div>

      {/* Active filter chips — only rendered when chips are present */}
      {(f.filterStates.length > 0 || f.filterStatuses.length > 0 || f.filterPositions.length > 0 || f.filterPriorities.length > 0 || f.filterYears.length > 0 || f.selectedTags.length > 0 || f.unvotedOnly || f.newMatches || Object.keys(f.cfFilters).some(k => (f.cfFilters[k]?.length ?? 0) > 0)) && (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4, alignItems: 'center' }}>
        {f.filterStates.map(s => (
          <ActiveChip key={`state-${s}`} label={s} color="gray" onRemove={() => f.setFilterStates(prev => prev.filter(x => x !== s))} />
        ))}
        {f.filterStatuses.map(s => (
          <ActiveChip key={`status-${s}`} label={decodeStatus(s) ?? s} color="gray" onRemove={() => f.setFilterStatuses(prev => prev.filter(x => x !== s))} />
        ))}
        {f.filterPositions.map(p => {
          const posLabel = p === FILTER_ANY ? 'Any position' : ((f.positionOptions.find(o => o.value === p) as { value: string; label?: string } | undefined)?.label ?? p)
          const posColor = POSITION_COLORS[p] ?? POSITION_FALLBACK
          return (
            <span key={`pos-${p}`} style={{
              fontSize: fontSize.sm, padding: '2px 4px 2px 8px', borderRadius: radius.sm,
              background: posColor.bg, color: posColor.color, border: `1px solid ${posColor.border}`,
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
              {posLabel}
              <button
                onClick={() => f.setFilterPositions(prev => prev.filter(x => x !== p))}
                style={{ background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer', color: posColor.color, lineHeight: 1, fontSize: fontSize.base, display: 'flex', alignItems: 'center' }}
              >×</button>
            </span>
          )
        })}
        {f.filterPriorities.map(p => {
          if (p === FILTER_ANY || p === 'none') {
            return <ActiveChip key={`pri-${p}`} label={p === FILTER_ANY ? 'Any priority' : 'No priority'} color="gray" onRemove={() => f.setFilterPriorities(prev => prev.filter(x => x !== p))} />
          }
          const pc = PRIORITY_COLORS[p] ?? PRIORITY_COLORS['medium']
          return (
            <span key={`pri-${p}`} style={{
              fontSize: fontSize.sm, padding: '2px 4px 2px 8px', borderRadius: radius.sm,
              background: pc.fill, color: pc.text,
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
              {pc.label ?? p}
              <button
                onClick={() => f.setFilterPriorities(prev => prev.filter(x => x !== p))}
                style={{ background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer', color: pc.text, lineHeight: 1, fontSize: fontSize.base, display: 'flex', alignItems: 'center' }}
              >×</button>
            </span>
          )
        })}
        {f.filterYears.map(y => (
          <ActiveChip key={`year-${y}`} label={`Year: ${y}`} color="gray" onRemove={() => f.setFilterYears(prev => prev.filter(x => x !== y))} />
        ))}
        {f.selectedTags.map(tag => (
          <ActiveChip key={`tag-${tag}`} label={tag === FILTER_ANY ? 'Any tag' : tag} color="blue" onRemove={() => f.handleTagClick(tag)} />
        ))}
        {f.unvotedOnly && (
          <ActiveChip label="Not yet voted" color="blue" onRemove={() => f.setUnvotedOnly(false)} />
        )}
        {f.newMatches && (
          <ActiveChip label="New matches" color="blue" onRemove={() => f.setNewMatches(false)} />
        )}
        {Object.entries(f.cfFilters).flatMap(([fieldId, values]) => {
          const field = customFieldDefs.find(fld => fld.id === fieldId)
          return values.map(v => (
            <ActiveChip
              key={`cf-${fieldId}-${v}`}
              label={field?.type === 'binary' ? (field?.name ?? fieldId) : `${field?.name ?? fieldId}: ${v === FILTER_ANY ? 'Any' : v}`}
              color="blue"
              onRemove={() => f.setCfFilter(fieldId, values.filter(x => x !== v))}
            />
          ))
        })}
      </div>
      )}

      {/* Bill count + sort info + resets — paddingLeft 10 + spinner(12) + gap(6) = 28px, aligning "X bills" with STATE column header (header has 8px inner padding + 12px checkbox col + 8px gap = 28px) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, fontSize: fontSize.sm, color: color.textMuted, flexWrap: 'wrap', paddingLeft: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 12, height: 12, border: `2px solid ${color.borderStrong}`, borderTopColor: color.accentBlue, borderRadius: '50%', animation: refreshing ? 'spin 0.7s linear infinite' : 'none', visibility: refreshing ? 'visible' : 'hidden' }} />
          {total > 0
            ? <>{total.toLocaleString()} {total === 1 ? 'bill' : 'bills'}</>
            : loading || refreshing ? null : <>0 bills</>
          }
        </span>
        {f.hasActiveFilters && (
          <button
            onClick={f.handleResetFilters}
            style={{
              fontSize: fontSize.sm, padding: '3px 10px', border: `1px solid ${color.borderDefault}`,
              borderRadius: radius.md, background: color.white, color: color.textSecondary, cursor: 'pointer',
            }}
          >
            Reset filters
          </button>
        )}
        <span className="bill-list-sort-desc">{sortDescription(sortCol, orgPositionLabel(orgNoun), 'Relevance')}</span>
        <button
          onClick={handleReset}
          style={{
            fontSize: fontSize.sm, padding: '3px 10px', border: `1px solid ${color.borderDefault}`,
            borderRadius: radius.md, background: color.white, color: color.textSecondary, cursor: 'pointer',
            visibility: sortCol !== 'default' ? 'visible' : 'hidden',
          }}
        >
          Reset sort
        </button>
      </div>
      </div>
      {/* Column headers at bottom of sticky block — containerType for @container responsive queries */}
      <div className="bill-list-header-wrapper" style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px', containerType: 'inline-size' } as React.CSSProperties}>
        <div style={{ padding: '6px 16px 6px 8px', background: color.surfaceSubtle, border: `1px solid ${color.borderDefault}`, borderBottom: `1px solid ${color.borderDefault}`, borderRadius: `${radius.lg}px ${radius.lg}px 0 0`, boxShadow: headerScrolled ? '0 5px 6px -4px rgba(0,0,0,0.18)' : 'none', transition: 'box-shadow 0.2s ease' }}>
          <div className={`bill-list-header-row${f.isMultiState ? ' bill-list-ms' : ''}`} style={{ display: 'grid', gridTemplateColumns: `12px ${OUTER_GRID}`, gap: 8, alignItems: 'center' }}>
            <div className="bill-list-header-checkbox" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {isAdmin && (
                <input
                  type="checkbox"
                  checked={selection.mode === 'filter'}
                  ref={el => { if (el) el.indeterminate = selection.mode === 'ids' }}
                  onChange={() => {
                    if (selection.mode === 'filter') handleClearSelection()
                    else handleSelectAllFilters()
                  }}
                  title={selection.mode === 'filter' ? 'Deselect all' : 'Select all matching filters'}
                  style={{ width: 15, height: 15, cursor: 'pointer', accentColor: color.accentBlue }}
                />
              )}
            </div>
            <div className="bill-row-chips-cell" style={{ display: 'grid', gridTemplateColumns: f.isMultiState ? CHIP_GRID_MULTISTATE : CHIP_GRID, ['--bill-col-w' as string]: f.isMultiState ? '105px' : '70px', gap: CHIP_GAP, alignItems: 'center', minWidth: 0, overflow: 'hidden' } as React.CSSProperties}>
              <SortHeader col="bill" label="Bill" current={sortCol} dir={sortDir} onSort={handleSort} naturalDir="asc" />
              <span className="bill-col-status"><SortHeader col="status" label="Status" current={sortCol} dir={sortDir} onSort={handleSort} /></span>
              <span className="bill-col-year"><SortHeader col="year" label="Year" current={sortCol} dir={sortDir} onSort={handleSort} /></span>
              <span className="bill-col-lastaction"><SortHeader col="lastAction" label="Last action" current={sortCol} dir={sortDir} onSort={handleSort} /></span>
              <SortHeader col="relevance" label="Relevance" current={sortCol} dir={sortDir} onSort={handleSort} />
            </div>
            <span className="bill-col-position"><SortHeader col="position" label="Position" current={sortCol} dir={sortDir} onSort={handleSort} /></span>
            <SortHeader col="priority" label="Priority" current={sortCol} dir={sortDir} onSort={handleSort} />
          </div>
        </div>
      </div>
      </div>

      {/* Scrolling bill rows. containerType lives on this padding wrapper (not the
          bordered .bill-list-container below) so the rows' @container query box has
          the same content-box width as the header wrapper above — both are 24px-padded,
          border-free divs. Putting it on .bill-list-container instead made its 1px
          border shrink the query box by 2px, so column breakpoints fired ~2px out of
          sync with the header and the status header could show while its chip hadn't. */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `0 24px ${isSelectionMode ? 100 : 32}px`, containerType: 'inline-size' } as React.CSSProperties}>
      <div className="bill-list-container" style={{ ...CARD, overflow: 'hidden', borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
        {sorted.length === 0 && !loading ? (
          <p style={{ color: color.textMuted, fontSize: fontSize.base, padding: '16px' }}>No bills match the current filters.</p>
        ) : (
          /* Virtualized bill rows */
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => (
              <div
                key={sorted[virtualRow.index].id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: virtualRow.start, width: '100%' }}
              >
                <BillRow
                  bill={sorted[virtualRow.index]}
                  index={virtualRow.index}
                  selectedTags={f.selectedTags}
                  onTagClick={f.handleTagClick}
                  isAdmin={isAdmin}
                  positionVocabulary={positionVocabulary}
                  onStatusClick={f.handleStatusClick}
                  onPriorityClick={f.handlePriorityClick}
                  onPositionClick={f.handlePositionClick}
                  onYearClick={f.yearFacetKeys.length > 0 ? f.handleYearClick : undefined}
                  onRelevanceClick={f.handleRelevanceClick}
                  onPriorityChange={handlePriorityChange}
                  onPositionChange={handlePositionChange}
                  onTriageDismiss={handleTriageDismiss}
                  onVote={user?.canVote ? handleVote : undefined}
                  filterStatuses={f.filterStatuses}
                  filterPriorities={f.filterPriorities}
                  filterPositions={f.filterPositions}
                  filterYears={f.filterYears}
                  filterMinRelevance={f.filterMinRelevance}
                  sortedPaths={sortedPaths}
                  isMultiState={f.isMultiState}
                  onNavigate={handleBillNavigate}
                  isSelectionMode={isSelectionMode}
                  isSelected={selection.mode === 'ids' ? selection.ids.has(sorted[virtualRow.index].id) : selection.mode === 'filter'}
                  onToggleSelect={isAdmin ? (shiftKey: boolean) => handleToggleSelect(sorted[virtualRow.index].id, virtualRow.index, shiftKey) : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Infinite scroll sentinel — IntersectionObserver fires next page fetch when this enters viewport */}
      <div ref={sentinelRef} style={{ height: 1 }} />
      {refreshing && hasMore && (
        <div style={{ textAlign: 'center', padding: '12px 0', fontSize: fontSize.sm, color: color.textMuted }}>
          Loading more…
        </div>
      )}
      </div>

      <FilterSheet
        isOpen={f.filterSheetOpen}
        onClose={() => f.setFilterSheetOpen(false)}
        statuses={f.filterStatuses}
        priorities={f.filterPriorities}
        positions={f.filterPositions}
        tags={f.selectedTags}
        sessions={f.filterYears.map(String)}
        minRelevance={f.filterMinRelevance}
        myBills={f.myBills}
        statusOptions={f.statuses.map(s => ({ value: s, label: decodeStatus(s) ?? s }))}
        priorityOptions={[
          { value: 'high', label: 'High' },
          { value: 'medium', label: 'Medium' },
          { value: 'low', label: 'Low' },
        ]}
        positionOptions={positionVocabulary.map(p => ({ value: p, label: p }))}
        tagOptions={f.allTags}
        sessionOptions={f.yearFacetKeys.map(y => ({ value: y, label: y }))}
        totalSessionCount={f.yearFacetKeys.length}
        onStatusChange={f.setFilterStatuses}
        onPriorityChange={f.setFilterPriorities}
        onPositionChange={f.setFilterPositions}
        onTagChange={f.handleTagsChange}
        onSessionChange={v => f.setFilterYears(v.map(Number).filter(n => !isNaN(n)))}
        onMinRelevanceChange={f.setFilterMinRelevance}
        onMyBillsChange={f.setMyBills}
        counts={{ ...filterCounts, session: filterCounts.year }}
        onClearAll={() => {
          f.setFilterStatuses([])
          f.setFilterPriorities([])
          f.setFilterPositions([])
          f.setFilterYears([])
          f.setFilterStates([])
          f.setFilterMinRelevance(0)
          f.setMyBills(false)
          setSearchParams({})
        }}
      />
      {isAdmin && (
        <BulkActionBar
          selection={selection}
          total={total}
          positionVocabulary={positionVocabulary}
          customFieldDefs={customFieldDefs.filter((fld): fld is typeof fld & { type: 'binary' | 'dropdown' } => fld.type === 'binary' || fld.type === 'dropdown')}
          currentFilters={f.currentFilters}
          filterNewMatchCount={filterCounts.newMatchesCount}
          selectedBills={selectedBills}
          onClearSelection={handleClearSelection}
          onApplied={handleBulkApplied}
        />
      )}
    </>
  )
}
