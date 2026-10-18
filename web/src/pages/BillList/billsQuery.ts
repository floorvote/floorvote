import type { SortColumn, SortDir } from './types'
import { PAGE_SIZE } from './constants'
import {
  BILL_FILTER_DEFS, parseBillFilter, serializeBillFilter, withBillFilter, type BillFilter,
} from '../../../../shared/billFilter'

/** A bill list's query: the bill filter, one immutable value, and the sort, which is the list's order and not a filter. */
export type BillsQuery = { filter: BillFilter; sortCol: SortColumn; sortDir: SortDir }

/** A custom field's definition, as far as naming it goes: the URL carries its slug, and the Bills page holds its id. */
export type CustomFieldNames = { id: string; slug: string | null }

/**
 * The bill filter with each custom field named by its id or by its slug. A field the defs do not know keeps the key it
 * had, and two keys for one field (its slug and its id) become one, each value once. A filter whose fields are already
 * named that way is returned as it is.
 */
export function withCustomFieldKeys(
  filter: BillFilter, defs: ReadonlyArray<CustomFieldNames>, as: 'id' | 'slug',
): BillFilter {
  const fields = new Map<string, string[]>()
  let changed = false
  for (const [key, values] of Object.entries(filter.cf)) {
    const def = defs.find(d => d.slug === key || d.id === key)
    const named = def ? (as === 'id' ? def.id : def.slug ?? def.id) : key
    if (named !== key) changed = true
    const bucket = fields.get(named)
    if (bucket) changed = true
    const into = bucket ?? []
    for (const v of values) {
      if (into.includes(v)) changed = true
      else into.push(v)
    }
    fields.set(named, into)
  }
  if (!changed) return filter
  // A key may be any text, so the fields are built into an object by defining each key as an own property.
  const cf = Object.freeze(Object.fromEntries([...fields].map(([key, values]) => [key, Object.freeze(values)])))
  return withBillFilter({ cf }, filter)
}

/**
 * A URL's search read as the Bills page holds it: the shared parse, then the things this page holds differently.
 * A custom field is held by its id (the URL carries slugs), a year is a number, a minimum relevance of zero is no
 * minimum, and session is dropped. Every place that reads a filter from a URL, a saved view, or the sidebar's links reads it here, so the page
 * and the loader's prefetch hold the same value.
 */
export function billFilterFromSearch(
  search: URLSearchParams, defs: ReadonlyArray<CustomFieldNames> = [],
): BillFilter {
  const parsed = withCustomFieldKeys(parseBillFilter(search), defs, 'id')
  const year = parsed.year.filter(y => y !== '' && !Number.isNaN(Number(y)))
  const minRelevance = parsed.minRelevance !== null && parsed.minRelevance > 0 ? parsed.minRelevance : null
  // The page has no control, chip, or count for session, so a session in a URL or view must not narrow the list
  // unseen. The API still accepts it from other callers.
  const session = Object.freeze([]) as readonly string[]
  if (year.length === parsed.year.length && minRelevance === parsed.minRelevance && parsed.session.length === 0) return parsed
  return withBillFilter({ year: Object.freeze(year), minRelevance, session }, parsed)
}

const SORT_COLS: SortColumn[] = ['priority', 'status', 'relevance', 'position', 'year', 'session', 'lastAction', 'bill']

/** A list URL's search as a query: its filter (see `billFilterFromSearch`) and its sort. */
export function billsQueryFromSearch(
  search: URLSearchParams, defs: ReadonlyArray<CustomFieldNames> = [],
): BillsQuery {
  const sortRaw = search.get('sort')
  return {
    filter: billFilterFromSearch(search, defs),
    sortCol: sortRaw && SORT_COLS.includes(sortRaw as SortColumn) ? (sortRaw as SortColumn) : 'default',
    sortDir: search.get('dir') === 'desc' ? 'desc' : 'asc',
  }
}

/**
 * The one place a bills request is written, and so the list cache key: the page, the filter as the shared serialize
 * writes it (custom fields by id, the form the hook holds), and the sort. The loader's prefetch, the split pane, and the
 * list's own fetch all come here, so they key the same list the same way and a warmed cache entry is found.
 */
export function billsApiParams(q: BillsQuery, page: number, pageSize: number): string {
  const parts = [`page=${page}`, `pageSize=${pageSize}`]
  const filter = serializeBillFilter(q.filter)
  if (filter !== '') parts.push(filter)
  if (q.sortCol !== 'default') parts.push(new URLSearchParams({ sort: q.sortCol, dir: q.sortDir }).toString())
  return parts.join('&')
}

/** The query string of GET /bills/facets for a filter: the same bill filter the list sends, with no page or sort. */
export function billsFacetParams(filter: BillFilter): string {
  return serializeBillFilter(filter)
}

/**
 * The filter as the Bills page's own URL carries it: a custom field by its slug, which is what a member sees and a
 * saved view stores, and without the search box, which is state and never reaches the URL.
 */
export function billFilterForUrl(filter: BillFilter, defs: ReadonlyArray<CustomFieldNames> = []): BillFilter {
  const named = withCustomFieldKeys(filter, defs, 'slug')
  return named.q === '' ? named : withBillFilter({ q: '' }, named)
}

/** The query string of a list URL ("/bills?status=2"), as search params. */
export function searchFromListUrl(listUrl: string): URLSearchParams {
  return new URLSearchParams(listUrl.includes('?') ? listUrl.slice(listUrl.indexOf('?') + 1) : '')
}

/**
 * A list URL's search as the GET /bills query string for one page, through
 * billsApiParams. The loader's prefetch and the split pane both build their
 * request here, so they key the same list the same way (and a warmed cache
 * entry is found).
 */
export function billsApiParamsFromSearch(
  search: URLSearchParams, page: number, defs: ReadonlyArray<CustomFieldNames> = [],
): string {
  return billsApiParams(billsQueryFromSearch(search, defs), page, PAGE_SIZE)
}

/** Whether a filter is set: a list with a value, a toggle that is on, or a minimum above zero. The group operator and the search box are not asked for here. */
const isSet = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0
    : typeof value === 'boolean' ? value
    : typeof value === 'number' ? value > 0
    : typeof value === 'object' && value !== null ? Object.keys(value).length > 0
    : false

/** Whether any filter but the named ones is set. Every filter the shared module names is asked, so a new one counts without an edit here. */
function anyFilterBut(filter: BillFilter, ignored: ReadonlyArray<keyof BillFilter>): boolean {
  return BILL_FILTER_DEFS.some(def => !ignored.includes(def.name) && isSet(filter[def.name]))
}

// Which Bills-nav count chip (if any) is "selected" — i.e. the current view is
// exactly that chip's canonical destination. Drives the persistent orange chip
// state in the sidebar. Sort/dir are ordering, not filters, so they're ignored.
//   - allBills:   on the unfiltered /bills list (the "X bills" chip's target)
//   - newMatches: on /bills with newMatches=1 as the *only* active filter
// Any other filter — or being off the /bills list — selects neither.
export function billsChipSelection(pathname: string, search: string): { allBills: boolean; newMatches: boolean } {
  if (pathname !== '/bills') return { allBills: false, newMatches: false }
  const f = billFilterFromSearch(new URLSearchParams(search))
  if (anyFilterBut(f, ['newMatches', 'q', 'match'])) return { allBills: false, newMatches: false }
  if (f.newMatches) return { allBills: false, newMatches: true }
  return { allBills: true, newMatches: false }
}

const PRIORITY_TIERS = ['high', 'medium', 'low']

// True when the active priority filter is exactly all three tiers — no more,
// no less — matching the prioritized-bills widget's canonical destination.
function isExactlyPriorityTiers(priorities: readonly string[]): boolean {
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
  const f = billFilterFromSearch(new URLSearchParams(search))
  if (!isExactlyPriorityTiers(f.priority)) return { priority: false, unvoted: false }
  if (anyFilterBut(f, ['priority', 'unvoted', 'q', 'match'])) return { priority: false, unvoted: false }
  if (f.unvoted) return { priority: false, unvoted: true }
  return { priority: true, unvoted: false }
}
