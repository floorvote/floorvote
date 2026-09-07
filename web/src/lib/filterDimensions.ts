/**
 * Single source of truth for the bill-list filter dimensions shown by both
 * the desktop toolbar (pages/BillList/index.tsx) and the mobile drill-down
 * sheet (components/FilterSheet.tsx).
 *
 * Before this module existed, each surface hard-coded its own labels
 * ("Session year" vs "Session", "Tag" vs "Topics", "My bills" vs "My voted
 * bills") and its own list of which dimensions to render at all — which let
 * State and New matches exist only on desktop. Both surfaces must now import
 * their labels and their "does this dimension appear at all" decision from
 * here; neither may hard-code a label string for these dimensions again.
 *
 * Two "kinds" exist because not every filter dimension is a pick-one-of-N
 * options list:
 *   - 'options': a set of selectable values (State, Status, Session year,
 *     Position, Priority, Tags, Subject). Desktop renders these as a
 *     `FilterDropdown`; mobile renders them as a drill-down chip list.
 *   - 'toggle': a single on/off control (My bills, New matches). Desktop
 *     renders these as a standalone button with a count badge; mobile keeps
 *     them as direct controls on the dimension list (level 1) rather than
 *     making them a drill-down target — the same treatment "Min. Relevance"
 *     already gets there, since neither is a list of options to choose among.
 */

export type FilterDimensionKind = 'options' | 'toggle'

/**
 * Which side of the group operator a dimension falls on.
 *
 *   'bill'   — a fact about the BILL. Renders in the chip row as a group and
 *              participates in the all-of/any-of operator.
 *   'viewer' — a fact about the VIEWER or the query. Renders in the scope
 *              cluster beside the search box and ALWAYS narrows.
 *
 * Deliberately independent of `kind`, which is a rendering concern. A binary
 * custom field renders as a toggle byte-identical to the My bills pill and is
 * nonetheless a bill fact — so control shape can never be used to derive this.
 * Any future "binary status read off a bill" lands on the correct side here
 * automatically.
 */
export type FilterDimensionScope = 'bill' | 'viewer'

/**
 * Everything a dimension's visibility can depend on. Both surfaces build
 * this from data they already compute (BillList's `f.uniqueStates` /
 * `isAdmin`) — nothing here is new state.
 */
export interface FilterDimensionContext {
  /** Distinct states the tenant's bills span (BillList's `f.uniqueStates`).
   *  Mirrors desktop's original gate on the State dropdown exactly:
   *  `f.uniqueStates.length > 0` — i.e. "at least one state is known", not
   *  "more than one". A tenant with no state data yet (uniqueStates empty)
   *  is the only case that hides it. */
  uniqueStates: string[]
  /** Current user is an admin or owner (BillList's `isAdmin`). */
  isAdmin: boolean
}

export interface FilterDimensionDef {
  /** Stable identifier. Used as the mobile drill-down key and as a lookup
   *  key everywhere else — never rendered directly. */
  key: string
  /** User-facing label. The ONLY place either surface may source this text. */
  label: string
  kind: FilterDimensionKind
  /** Which side of the group operator this dimension falls on. See
   *  `FilterDimensionScope` for the full semantics. */
  scope: FilterDimensionScope
  /** Whether this dimension appears at all, independent of whether it
   *  happens to have any options loaded yet. Each surface still applies its
   *  own "no options loaded yet" check for options-kind dimensions on top of
   *  this (e.g. desktop only renders the Tags dropdown once `allTags.length
   *  > 0`) — that data-availability check was never part of the drift this
   *  module fixes, so it stays local to each surface. */
  isVisible: (ctx: FilterDimensionContext) => boolean
}

export const FILTER_DIMENSIONS: readonly FilterDimensionDef[] = [
  { key: 'state',      label: 'State',         kind: 'options', scope: 'bill',   isVisible: ctx => ctx.uniqueStates.length > 0 },
  { key: 'myBills',    label: 'My bills',      kind: 'toggle',  scope: 'viewer', isVisible: () => true },
  { key: 'newMatches', label: 'New matches',   kind: 'toggle',  scope: 'viewer', isVisible: ctx => ctx.isAdmin },
  { key: 'unvoted',    label: 'Not yet voted', kind: 'toggle',  scope: 'viewer', isVisible: () => true },
  { key: 'status',     label: 'Status',        kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'session',    label: 'Session year',  kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'position',   label: 'Position',      kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'priority',   label: 'Priority',      kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'tags',       label: 'Tags',          kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'subjects',   label: 'Subject',       kind: 'options', scope: 'bill',   isVisible: () => true },
] as const

export type FilterDimensionKey = (typeof FILTER_DIMENSIONS)[number]['key']

const BY_KEY = new Map<FilterDimensionKey, FilterDimensionDef>(
  FILTER_DIMENSIONS.map(d => [d.key as FilterDimensionKey, d]),
)

function get(key: FilterDimensionKey): FilterDimensionDef {
  const d = BY_KEY.get(key)
  if (!d) throw new Error(`Unknown filter dimension: ${key}`)
  return d
}

/** The one place either surface may read a dimension's display label. */
export function filterDimensionLabel(key: FilterDimensionKey): string {
  return get(key).label
}

/** Whether `key` should appear at all under `ctx`. Both surfaces must gate
 *  State and New matches through this rather than re-deriving the condition. */
export function isFilterDimensionVisible(key: FilterDimensionKey, ctx: FilterDimensionContext): boolean {
  return get(key).isVisible(ctx)
}

/** All dimensions visible under `ctx`, in registry order. */
export function visibleFilterDimensions(ctx: FilterDimensionContext): FilterDimensionDef[] {
  return FILTER_DIMENSIONS.filter(d => d.isVisible(ctx))
}
