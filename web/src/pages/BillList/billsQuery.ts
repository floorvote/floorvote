import type { SortColumn, SortDir } from './types'

export type BillsFilterValues = {
  statuses: string[]; priorities: string[]; positions: string[]; years: number[]; states: string[]
  minRelevance: number; myBills: boolean; unvoted: boolean; newMatches: boolean
  tags: string[]; search: string; sortCol: SortColumn; sortDir: SortDir; cfFilters: Record<string, string[]>
}

export function billsApiParams(v: BillsFilterValues, page: number, pageSize: number): string {
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  v.statuses.forEach(s => params.append('status', s))
  v.priorities.forEach(p => params.append('priority', p))
  v.positions.forEach(p => params.append('position', p))
  v.years.forEach(y => params.append('year', String(y)))
  v.states.forEach(s => params.append('state', s))
  if (v.minRelevance > 0) params.set('minRelevance', String(v.minRelevance))
  if (v.myBills) params.set('myBills', '1')
  if (v.unvoted) params.set('unvoted', '1')
  if (v.newMatches) params.set('newMatches', '1')
  v.tags.forEach(t => params.append('tag', t))
  if (v.search) params.set('q', v.search)
  if (v.sortCol !== 'default') {
    params.set('sort', v.sortCol)
    params.set('dir', v.sortDir)
  }
  for (const [key, values] of Object.entries(v.cfFilters)) {
    values.forEach(val => params.append(`cf_${key}`, val))
  }
  return params.toString()
}

const SORT_COLS: SortColumn[] = ['priority', 'status', 'relevance', 'position', 'year', 'session', 'lastAction', 'bill']

export function billsFilterValuesFromSearch(search: URLSearchParams): BillsFilterValues {
  const sortRaw = search.get('sort')
  const cfFilters: Record<string, string[]> = {}
  for (const [key, value] of search.entries()) {
    if (key.startsWith('cf_')) {
      const id = key.slice(3)
      if (!cfFilters[id]) cfFilters[id] = []
      cfFilters[id].push(value)
    }
  }
  return {
    statuses: search.getAll('status'),
    priorities: search.getAll('priority'),
    positions: search.getAll('position'),
    years: search.getAll('year').map(Number).filter(n => !isNaN(n)),
    states: search.getAll('state'),
    minRelevance: search.get('minRelevance') ? Number(search.get('minRelevance')) : 0,
    myBills: search.get('myBills') === '1',
    unvoted: search.get('unvoted') === '1',
    newMatches: search.get('newMatches') === '1',
    tags: search.getAll('tag'),
    search: '', // q is never carried in the /bills URL — sidebar nav never has a search term
    sortCol: sortRaw && SORT_COLS.includes(sortRaw as SortColumn) ? (sortRaw as SortColumn) : 'default',
    sortDir: search.get('dir') === 'desc' ? 'desc' : 'asc',
    cfFilters,
  }
}

// Which Bills-nav count chip (if any) is "selected" — i.e. the current view is
// exactly that chip's canonical destination. Drives the persistent orange chip
// state in the sidebar. Sort/dir are ordering, not filters, so they're ignored.
//   - allBills:   on the unfiltered /bills list (the "X bills" chip's target)
//   - newMatches: on /bills with newMatches=1 as the *only* active filter
// Any other filter — or being off the /bills list — selects neither.
export function billsChipSelection(pathname: string, search: string): { allBills: boolean; newMatches: boolean } {
  if (pathname !== '/bills') return { allBills: false, newMatches: false }
  const v = billsFilterValuesFromSearch(new URLSearchParams(search))
  const otherFiltersActive =
    v.statuses.length > 0 || v.priorities.length > 0 || v.positions.length > 0 ||
    v.years.length > 0 || v.states.length > 0 || v.minRelevance > 0 ||
    v.myBills || v.unvoted || v.tags.length > 0 || Object.keys(v.cfFilters).length > 0
  if (otherFiltersActive) return { allBills: false, newMatches: false }
  if (v.newMatches) return { allBills: false, newMatches: true }
  return { allBills: true, newMatches: false }
}

const PRIORITY_TIERS = ['high', 'medium', 'low']

// True when the active priority filter is exactly all three tiers — no more,
// no less — matching the prioritized-bills widget's canonical destination.
function isExactlyPriorityTiers(priorities: string[]): boolean {
  return priorities.length === 3 && PRIORITY_TIERS.every(tier => priorities.includes(tier))
}

// Which prioritized-bills widget chip (if any) is "selected" — i.e. the current
// view is exactly that chip's canonical destination. Drives the persistent
// orange chip state in the sidebar's Prioritized bills widget, mirroring
// billsChipSelection for the nav Bills chips above.
//   - priority: on /bills with priority=[high,medium,low] (all three, no more,
//     no less) as the only active filter — unvoted NOT set.
//   - unvoted:  the same priority filter, but WITH unvoted=1 also set, and
//     nothing else active.
// Any other filter combination — or being off the /bills list — selects neither.
export function prioritizedChipSelection(pathname: string, search: string): { priority: boolean; unvoted: boolean } {
  if (pathname !== '/bills') return { priority: false, unvoted: false }
  const v = billsFilterValuesFromSearch(new URLSearchParams(search))
  if (!isExactlyPriorityTiers(v.priorities)) return { priority: false, unvoted: false }
  const otherFiltersActive =
    v.statuses.length > 0 || v.positions.length > 0 ||
    v.years.length > 0 || v.states.length > 0 || v.minRelevance > 0 ||
    v.myBills || v.newMatches || v.tags.length > 0 || Object.keys(v.cfFilters).length > 0
  if (otherFiltersActive) return { priority: false, unvoted: false }
  if (v.unvoted) return { priority: false, unvoted: true }
  return { priority: true, unvoted: false }
}
