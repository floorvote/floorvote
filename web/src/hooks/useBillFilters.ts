import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { useSearchParams } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import type { CustomFieldDef, FacetCounts, SortColumn, SortDir } from '../pages/BillList/types'
import { STATUS_SEMANTIC_ORDER } from '../pages/BillList/constants'
import { FILTER_ANY } from '../pages/BillList/FilterPanel'
import { knownStates, knownStatuses, knownTagsCache } from '../pages/BillList'

type SearchParams = ReturnType<typeof useSearchParams>[0]
type SetSearchParams = ReturnType<typeof useSearchParams>[1]

export function useBillFilters(opts: {
  searchParams: SearchParams
  setSearchParams: SetSearchParams
  location: Location
  facetCounts: FacetCounts
  customFieldDefs: CustomFieldDef[]
  positionVocabulary: string[]
  sortCol: SortColumn
  sortDir: SortDir
  setSortCol: (c: SortColumn) => void
  setSortDir: (d: SortDir) => void
}) {
  const { searchParams, setSearchParams, location, facetCounts, customFieldDefs, positionVocabulary, sortCol, sortDir, setSortCol, setSortDir } = opts

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
    q: search,
    minRelevance: filterMinRelevance,
    myBills,
    unvoted: unvotedOnly,
    newMatches,
    cf: cfFilters,
  }), [filterStatuses, filterPriorities, filterPositions, filterYears, filterStates, selectedTags, search, filterMinRelevance, myBills, unvotedOnly, newMatches, cfFilters])

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
    if (sortCol !== 'default') {
      next.set('sort', sortCol)
      next.set('dir', sortDir)
    }
    // Preserve cf_ params managed outside this effect
    for (const [key, value] of searchParams.entries()) {
      if (key.startsWith('cf_')) {
        next.append(key, value)
      }
    }
    const searchStr = '?' + next.toString()
    lastWrittenSearch.current = searchStr
    setSearchParams(next, { replace: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatuses, filterPriorities, filterPositions, filterYears, filterStates, filterMinRelevance, myBills, unvotedOnly, newMatches, selectedTags, sortCol, sortDir])

  const handleTagClick = useCallback((tag: string) => {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])
  }, [])

  const handleTagsChange = useCallback((tags: string[]) => {
    setSelectedTags(tags)
  }, [])

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
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const key of [...next.keys()]) {
        if (key.startsWith('cf_')) next.delete(key)
      }
      return next
    })
  }, [setSearchParams])

  const hasActiveFilters = !!(
    search || filterStatuses.length > 0 || filterPriorities.length > 0 || filterPositions.length > 0 ||
    filterYears.length > 0 || filterStates.length > 0 || filterMinRelevance > 0 || selectedTags.length > 0 || myBills || unvotedOnly || newMatches ||
    Object.keys(cfFilters).some(k => (cfFilters[k]?.length ?? 0) > 0)
  )

  const totalActiveFilters = filterStatuses.length + filterPriorities.length + filterPositions.length + selectedTags.length + filterYears.length + filterStates.length + (filterMinRelevance > 0 ? 1 : 0) + (myBills ? 1 : 0) + (unvotedOnly ? 1 : 0) + (newMatches ? 1 : 0) + Object.values(cfFilters).reduce((sum, v) => sum + v.length, 0)

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
  // The facets API stuffs a FILTER_ANY ('__any__') key into tags to carry the
  // "Any tag" count badge; it must never surface as a selectable tag option.
  const allTags = useMemo(
    () => [...new Set([...knownTagsCache, ...Object.keys(facetCounts.tags)])].filter(t => t !== FILTER_ANY).sort(),
    [facetCounts.tags]
  )
  const positionOptions = useMemo(
    () => [...positionVocabulary.map(p => ({ value: p })), { value: 'none', label: 'Not set' }],
    [positionVocabulary]
  )

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
    cfFilters, setCfFilter,
    currentFilters,
    handleTagClick, handleTagsChange, handleStatusClick, handlePriorityClick,
    handlePositionClick, handleYearClick, handleRelevanceClick, handleResetFilters,
    yearFacetKeys, statuses, allTags, positionOptions, uniqueStates, isMultiState,
    hasActiveFilters, totalActiveFilters,
  }
}
