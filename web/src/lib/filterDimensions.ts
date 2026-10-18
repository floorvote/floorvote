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
 *   - 'options': a set of selectable values (State, Status, Stage, Session
 *     year, Position, Priority, Tags, Subject). Desktop renders these as a
 *     `FilterDropdown`; mobile renders them as a drill-down chip list.
 *   - 'toggle': a single on/off control (My bills, New matches). Desktop
 *     renders these as a standalone button with a count badge; mobile keeps
 *     them as direct controls on the dimension list (level 1) rather than
 *     making them a drill-down target — the same treatment "Min. Relevance"
 *     already gets there, since neither is a list of options to choose among.
 */

import type { ActiveFilter } from '../../../shared/billFilter'

export type FilterDimensionKind = 'options' | 'toggle'

/**
 * Which side of the group operator a dimension falls on.
 *
 *   'bill'     — describes the LEGISLATION: what it is, where it is in the
 *                process, what it is about. Renders in the chip row as a group
 *                and participates in the all-of/any-of operator.
 *   'workflow' — describes WHERE THE BILL SITS IN OUR HANDLING of it: I have
 *                engaged with it, I have not acted on it, nobody has triaged
 *                it, it is not filed yet. Renders in the scope cluster beside
 *                the search box and ALWAYS narrows.
 *
 * This axis was called 'viewer' ("a fact about the VIEWER") until 2026-09-22,
 * and that label was already wrong for one of its members: newMatches is driven
 * by triaged_at / triaged_by, which are columns on the bills table and
 * org-shared — listRoutes.ts says so directly. Nothing about it is per-viewer.
 * Drafts would have deepened the same confusion, so the axis was renamed to
 * what it actually distinguishes.
 *
 * Deliberately independent of `kind`, which is a rendering concern. A binary
 * custom field renders as a toggle byte-identical to the My bills pill and is
 * nonetheless a bill fact — so control shape can never be used to derive this.
 *
 * One genuine irregularity, recorded so it is not rediscovered as a bug:
 * Priority and Position are arguably "our handling" too, and they stay on the
 * bill side. They are multi-value option lists where OR-ing is a real query
 * intent ("high or medium"), which is what the operator exists to serve. So the
 * boundary is partly conceptual and partly a question of whether OR-ing the
 * dimension means anything.
 */
export type FilterDimensionScope = 'bill' | 'workflow'

/**
 * Everything a dimension's visibility can depend on. Both surfaces build
 * this from data they already compute (BillList's `f.uniqueStates` /
 * `isAdmin` / `f.isMultiState`) — nothing here is new state.
 */
export interface FilterDimensionContext {
  /** Distinct states the tenant's bills span (BillList's `f.uniqueStates`).
   *  Used only by custom field visibility checks and subject-group
   *  organization — not by the State dimension itself, which gates on
   *  `isMultiState` instead. */
  uniqueStates: string[]
  /** Current user is an admin or owner (BillList's `isAdmin`). */
  isAdmin: boolean
  /** The tenant's bills span more than one state (`useBillFilters`'s
   *  `isMultiState`, i.e. `knownStates.size > 1`). A single-state instance
   *  offers a choice of one, so State is hidden there. */
  isMultiState: boolean
  /** Whether the tenant has ANY draft (pre-filed) bill at all — unfiltered,
   *  from `GET /bills/facets`'s `hasDrafts`. This is the chip's visibility
   *  signal: unlike a filtered count, it never swings to zero just because
   *  the active dimensional filters happen to exclude drafts (e.g. a status
   *  filter matching no drafts). The filtered `draftCount` badge is a
   *  separate value read directly by the two surfaces, not through this
   *  context — see FacetCounts. */
  hasDrafts: boolean
  /** Whether the Drafts filter is currently ON (`f.drafts` / the sheet's
   *  `drafts` prop). The chip must stay visible whenever its own filter is
   *  active, even if that filter combined with others now matches zero
   *  drafts — otherwise a user has no way to turn it back off except Reset. */
  draftsActive: boolean
  /** Whether the New matches filter is currently ON. The filter is otherwise
   *  admin-only, but a member lands on it from the digest and from the feed's
   *  new-matches row, and must keep a chip that names it and clears it. */
  newMatchesActive: boolean
  /** Whether some covered state's provider fills in the in-committee statuses
   *  (`useStageFilterUseful`). Absent counts as true. */
  stageUseful?: boolean
  /** Whether a Stage filter is applied (from a saved view or URL). Keeps the
   *  dimension visible so the filter can still be seen and turned off. */
  stageActive?: boolean
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
  /** The filter is a pill beside the search box and never a chip, so the chip row leaves it out while the badge,
   *  Reset, and the summary still count it. */
  hasOwnPill?: boolean
  /** The filter is counted and drawn even where its control is hidden, because it narrows the list all the same. */
  countsWhenHidden?: boolean
}

export const FILTER_DIMENSIONS: readonly FilterDimensionDef[] = [
  // Counted where its control is hidden (a single-state instance), since a state in a link still narrows the list.
  { key: 'state',      label: 'State',         kind: 'options', scope: 'bill',   isVisible: ctx => ctx.isMultiState, countsWhenHidden: true },
  { key: 'myBills',    label: 'My bills',      kind: 'toggle',  scope: 'workflow', isVisible: () => true, hasOwnPill: true },
  // Admin-only worklist, but visible to anyone while its own filter is on, so a member
  // who followed a link to it can see what is narrowing the list and turn it off.
  { key: 'newMatches', label: 'New matches',   kind: 'toggle',  scope: 'workflow', isVisible: ctx => ctx.isAdmin || ctx.newMatchesActive, hasOwnPill: true },
  { key: 'unvoted',    label: 'Not yet voted', kind: 'toggle',  scope: 'workflow', isVisible: () => true, hasOwnPill: true },
  // Hidden only when the tenant has no drafts at all (hasDrafts). Never
  // hidden because the active filters happen to exclude drafts — draftsActive
  // is the safety net that keeps the chip (and its own way to turn itself
  // back off) visible while the Drafts filter is on, regardless of hasDrafts.
  { key: 'drafts',     label: 'Drafts',        kind: 'toggle',  scope: 'workflow', isVisible: ctx => ctx.hasDrafts || ctx.draftsActive, hasOwnPill: true },
  { key: 'status',     label: 'Status',        kind: 'options', scope: 'bill',   isVisible: () => true },
  // A status's common stage (Introduced, In committee, ..., Enacted), which
  // compares bills across states whose status names differ. Hidden when every
  // covered state is on LegiScan, which almost never reports in-committee.
  { key: 'stage',      label: 'Stage',         kind: 'options', scope: 'bill',   isVisible: ctx => ctx.stageUseful !== false || !!ctx.stageActive },
  { key: 'year',       label: 'Session year',  kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'position',   label: 'Position',      kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'priority',   label: 'Priority',      kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'tag',        label: 'Tags',          kind: 'options', scope: 'bill',   isVisible: () => true },
  { key: 'subject',    label: 'Subject',       kind: 'options', scope: 'bill',   isVisible: () => true },
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

/** The filters with their own pill, as a set of names. */
const OWN_PILL: ReadonlySet<string> = new Set(FILTER_DIMENSIONS.filter(d => d.hasOwnPill).map(d => d.key))

/**
 * The entries of the list of active filters that draw chips: every one but the filters with their own pill, and the
 * search, which is its own box. They stay in the list, so the badge, Reset, and the summary count them.
 */
export function chipFilters(active: readonly ActiveFilter[]): ActiveFilter[] {
  return active.filter(a => !OWN_PILL.has(a.name) && a.name !== 'search')
}

/**
 * The filters this instance does not offer under `ctx`, which the list of active filters leaves out. A filter
 * with its own hidden-when-off rule (Drafts, New matches) stays visible while it is on, so one that is on is never
 * in this list, and a filter that is off has no value to leave out.
 */
export function hiddenFilterDimensions(ctx: FilterDimensionContext): FilterDimensionKey[] {
  return FILTER_DIMENSIONS.filter(d => !d.countsWhenHidden && !d.isVisible(ctx)).map(d => d.key as FilterDimensionKey)
}

/**
 * The filters each chip selection leaves out when it asks whether "any other filter" is set: the Bills nav chip's
 * (the new matches it selects, and the search box) and the prioritized-bills widget's (the priority tiers and the
 * not-yet-voted toggle it selects, and the search box). The match mode is never in the list, so it is never named.
 */
export const CHIP_SELECTION_LEAVES_OUT: Record<'billsNav' | 'prioritized', readonly string[]> = {
  billsNav: ['newMatches', 'search'],
  prioritized: ['priority', 'unvoted', 'search'],
}

// Stubs, to be written in the next commit (#677).
export function isStatusGroupedByStage(_ctx: FilterDimensionContext): boolean {
  return undefined as unknown as boolean
}
export const STAGE_FILTER_LABEL = ''
