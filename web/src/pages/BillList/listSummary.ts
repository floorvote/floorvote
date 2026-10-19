import type { BillsQuery } from './billsQuery'
import { activeFilters, encodeSubjectFilter } from '../../../../shared/billFilter'
import { FILTER_DIMENSIONS, filterDimensionLabel } from '../../lib/filterDimensions'
import { activeFilterLabelGroups, type ChipFieldDef } from './activeFilterGroups'
import type { SortColumn } from './types'

export type SummaryFieldDef = ChipFieldDef
export type ListSummaryInput = {
  /** The list's query: its bill filter, and its sort. */
  values: BillsQuery
  /** The saved view the list was opened from, if one is applied. */
  view?: { name: string } | null
  customFieldDefs?: ReadonlyArray<SummaryFieldDef>
  isMultiState?: boolean
  /** Filters this instance does not offer, which the list of active filters leaves out. */
  hidden?: readonly string[]
}
export type ListSummary = {
  /** The line: "<N filters | All bills | view name> · Sorted by <sort>". */
  text: string
  /** The sort, as the Bills page's column header names it. */
  sortName: string
  /** Chips, scope pills, and a search term, each selected value counted once. */
  filterCount: number
  /** One label per counted filter, worded as the Bills page's chips are. */
  filters: string[]
  viewName: string | null
}

// The Bills page's column headers (index.tsx), by sort column. 'session' is the
// Year column's other sort, as sortDescription treats it. The default order has
// no header of its own.
const SORT_NAMES: Record<Exclude<SortColumn, 'default'>, string> = {
  bill: 'Bill', status: 'Status', year: 'Year', session: 'Year', lastAction: 'Last action',
  relevance: 'Relevance', position: 'Position', priority: 'Priority',
}
export const DEFAULT_SORT_NAME = 'default order'

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)]

/**
 * What a bill list's filters and sort come to, for the split pane's summary
 * line. "Filters" are the Bills page's chips, its scope pills (My bills, New
 * matches, Not yet voted, Drafts), and a search term, which the chip row never
 * carries but a member still counts as a filter. The all-of/any-of operator is
 * not a filter.
 */
export function buildListSummary({ values, view, customFieldDefs = [], isMultiState = false, hidden }: ListSummaryInput): ListSummary {
  const { filter } = values
  // The one list of active filters, the same the badge, Reset, and the chips read. Each entry is one line here, so
  // the count of lines is the badge's count plus the search term. The scope pills (a filter with its own pill) are
  // listed too, because they narrow the list like any filter and the app links to lists that carry only one
  // (/bills?newMatches=1), so a summary that left them out would read "All bills" over a narrowed list.
  const active = activeFilters(filter, { hidden })
  const onList = new Set<string>(active.map(a => a.name))
  const field = Object.fromEntries(Object.entries(filter.field).map(([k, v]) => [k, unique([...v])]))
  const chipLabels = activeFilterLabelGroups({
    state: unique([...filter.state]),
    status: unique([...filter.status]),
    stage: unique([...filter.stage]),
    position: unique([...filter.position]),
    priority: unique([...filter.priority]),
    year: unique(filter.year.map(Number)),
    tag: unique([...filter.tag]),
    subject: unique(filter.subject.map(s => encodeSubjectFilter(s.state, s.name))),
    committee: unique([...filter.committee]),
    committeeScope: filter.committeeScope,
    field,
    minRelevance: filter.minRelevance ?? 0,
    positionOptions: [{ value: 'none', label: 'Not set' }],
    customFieldDefs,
    isMultiState,
    active,
  }).flatMap(g => g.labels)

  const term = filter.search.trim()
  const pillLabels = FILTER_DIMENSIONS.filter(d => d.hasOwnPill && onList.has(d.key)).map(d => filterDimensionLabel(d.key))
  const filters = [...(onList.has('search') ? [`Search: “${term}”`] : []), ...pillLabels, ...chipLabels]
  const sortName = values.sortCol === 'default' ? DEFAULT_SORT_NAME : SORT_NAMES[values.sortCol] ?? DEFAULT_SORT_NAME
  const viewName = view?.name.trim() ? view.name.trim() : null
  const lead = viewName
    ?? (filters.length === 0 ? 'All bills' : `${filters.length.toLocaleString()} ${filters.length === 1 ? 'filter' : 'filters'}`)
  return { text: `${lead} · Sorted by ${sortName}`, sortName, filterCount: filters.length, filters, viewName }
}
