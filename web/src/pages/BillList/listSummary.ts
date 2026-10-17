import type { BillsFilterValues } from './billsQuery'
import { activeFilterLabelGroups, type ChipFieldDef } from './activeFilterGroups'
import type { SortColumn } from './types'

export type SummaryFieldDef = ChipFieldDef
export type ListSummaryInput = {
  values: BillsFilterValues
  /** The saved view the list was opened from, if one is applied. */
  view?: { name: string } | null
  customFieldDefs?: ReadonlyArray<SummaryFieldDef>
  isMultiState?: boolean
}
export type ListSummary = {
  /** The line: "<N filters | All bills | view name> · Sorted by <sort>". */
  text: string
  /** The sort, as the Bills page's column header names it. */
  sortName: string
  /** Chips plus a search term, each selected value counted once. */
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
 * line. "Filters" are what the Bills page shows as chips (the scope pills — My
 * bills, Not yet voted, New matches, Drafts — are not chips, so they are not
 * counted) plus a search term, which the chip row never carries but a member
 * still counts as a filter.
 */
export function buildListSummary({ values, view, customFieldDefs = [], isMultiState = false }: ListSummaryInput): ListSummary {
  const cfFilters = Object.fromEntries(Object.entries(values.cfFilters).map(([k, v]) => [k, unique(v)]))
  const chipLabels = activeFilterLabelGroups({
    filterStates: unique(values.states),
    filterStatuses: unique(values.statuses),
    filterStages: unique(values.stages),
    filterPositions: unique(values.positions),
    filterPriorities: unique(values.priorities),
    filterYears: unique(values.years),
    selectedTags: unique(values.tags),
    selectedSubjects: unique(values.subjects),
    cfFilters,
    filterMinRelevance: values.minRelevance,
    positionOptions: [{ value: 'none', label: 'Not set' }],
    customFieldDefs,
    isMultiState,
  }).flatMap(g => g.labels)

  const term = values.search.trim()
  const filters = term ? [`Search: “${term}”`, ...chipLabels] : chipLabels
  const sortName = values.sortCol === 'default' ? DEFAULT_SORT_NAME : SORT_NAMES[values.sortCol] ?? DEFAULT_SORT_NAME
  const viewName = view?.name.trim() ? view.name.trim() : null
  const lead = viewName
    ?? (filters.length === 0 ? 'All bills' : `${filters.length.toLocaleString()} ${filters.length === 1 ? 'filter' : 'filters'}`)
  return { text: `${lead} · Sorted by ${sortName}`, sortName, filterCount: filters.length, filters, viewName }
}
