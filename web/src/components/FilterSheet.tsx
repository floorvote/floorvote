import { useEffect, useRef, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { COUNT_BADGE } from '../lib/chipStyles'
import type { SubjectGroup } from '../pages/BillList/FilterPanel'
import type { CustomFieldDef } from '../pages/BillList/types'
import { FilterSheetVirtualList } from './FilterSheetVirtualList'
import { useStageFilterUseful } from '../lib/capabilities'
import { STAGE_FILTER_LABEL, filterDimensionLabel, hiddenFilterDimensions, isFilterDimensionVisible, isStatusGroupedByStage, type FilterDimensionContext } from '../lib/filterDimensions'
import { stageCheckState, toggleStageSelection, type StatusStageGroup } from '../lib/statusGroups'
import { TriStateCheckbox } from './TriStateCheckbox'
import { STAGE_HEADING_HINT } from '../pages/BillList/FilterPanel'
import { activeFilters, decodeSubjectFilter, withBillFilter } from '../../../shared/billFilter'
import { filterableCustomFields } from '../lib/customFieldFilters'
import { buildActiveFilterGroups } from '../pages/BillList/activeFilterGroups'
import { GroupOperator } from '../pages/BillList/GroupOperator'
import { CommitteeScopeSwitch } from '../pages/BillList/CommitteeFilter'
import { committeeLabelsOf, type CommitteeGroup } from '../lib/committeeGroups'

interface FilterSheetProps {
  isOpen: boolean
  onClose: () => void
  status: string[]
  stage: string[]
  priority: string[]
  position: string[]
  tag: string[]
  subject: string[]
  year: string[]
  state: string[]
  minRelevance: number
  myBills: boolean
  /** The search box's text. The sheet has no control for it, but a search is an active filter, so it shows Reset. */
  search?: string
  /** Admin-gates the New matches toggle — same check as desktop's `isAdmin`. */
  isAdmin: boolean
  newMatches: boolean
  newMatchesCount?: number
  unvoted: boolean
  unvotedCount?: number
  drafts: boolean
  draftCount?: number
  /** Whether the tenant has any draft bill at all, unfiltered — same value
   *  desktop reads as `facetCounts.hasDrafts`, used only to decide whether
   *  the Drafts dimension appears (see lib/filterDimensions.ts). */
  hasDrafts?: boolean
  /** Whether active bill-fact filter groups combine with AND ('all', the
   *  default) or OR ('any') — same value desktop reads/writes as `f.match`
   *  / `f.setMatch`. Rendered between groups in this sheet's active-chip
   *  summary via `GroupOperator`, identically to desktop's chip row. */
  match: 'all' | 'any'
  onMatchChange: (v: 'all' | 'any') => void
  /** Distinct states the tenant's bills span — same value desktop passes as
   *  `f.uniqueStates`, used only to decide whether the State dimension
   *  appears (see lib/filterDimensions.ts). */
  uniqueStates: string[]
  /** The tenant's bills span more than one state — same value as desktop's
   *  `f.isMultiState`, gated by `knownStates.size > 1`. */
  isMultiState: boolean
  statusOptions: { value: string; label: string }[]
  stageOptions: { value: string; label: string }[]
  /**
   * The statuses under stage headings, in place of the two lists above: the Status row then opens a list with a
   * heading for each stage, and there is no Stage row (#677). Null for an API that sends no statusGroups, which
   * leaves a Status row and a Stage row, as before. The sheet still keeps Status flat where Stage was never offered.
   */
  statusGroups?: StatusStageGroup[] | null
  priorityOptions: { value: string; label: string }[]
  positionOptions: { value: string; label: string }[]
  tagOptions: string[]
  subjectGroups: SubjectGroup[]
  /** The committees picked (#471), how the filter reads them, and the options (`committeeGroups`). Same values desktop reads. */
  committee?: string[]
  committeeScope?: 'current' | 'any'
  committeeGroups?: CommitteeGroup[]
  onCommitteeChange?: (v: string[]) => void
  onCommitteeScopeChange?: (v: 'current' | 'any') => void
  yearOptions: { value: string; label: string }[]
  totalYearCount?: number
  stateOptions: { value: string; label: string }[]
  /** All tenant custom field defs (unfiltered) — same value desktop reads as
   *  `customFieldDefs`. This component decides filterability itself via
   *  lib/customFieldFilters.ts, mirroring desktop exactly. */
  customFieldDefs: CustomFieldDef[]
  /** Currently-selected values per custom field id — same shape as desktop's
   *  `f.field`. */
  field: Record<string, string[]>
  onFieldChange: (fieldId: string, values: string[]) => void
  onStatusChange: (v: string[]) => void
  onStageChange: (v: string[]) => void
  onPriorityChange: (v: string[]) => void
  onPositionChange: (v: string[]) => void
  onTagChange: (v: string[]) => void
  onSubjectChange: (v: string[]) => void
  onYearChange: (v: string[]) => void
  onStateChange: (v: string[]) => void
  onMinRelevanceChange: (v: number) => void
  onMyBillsChange: (v: boolean) => void
  onNewMatchesChange: (v: boolean) => void
  onUnvotedChange: (v: boolean) => void
  onDraftsChange: (v: boolean) => void
  onClearAll: () => void
  counts?: {
    status: Record<string, number>
    stage?: Record<string, number>
    priority: Record<string, number>
    position: Record<string, number>
    year: Record<string, number>
    tag: Record<string, number>
    state?: Record<string, number>
    field?: Record<string, Record<string, number>>
  }
}

// The drill-down (options-list) dimensions. "My bills", "New matches", and
// "Not yet voted" (single toggles) and "Min. Relevance" (a slider) aren't
// included here — none is a list of options to choose among, so all four
// stay as direct controls on the dimension list (level 1) rather than
// becoming a drill-down target of their own. See lib/filterDimensions.ts for
// the full registry (including the three toggles) that both this component
// and the desktop toolbar read their labels and visibility from.
//
// Dropdown-type custom fields are drill-down dimensions too, but they're
// dynamic (tenant-defined, a variable count) rather than fixed registry
// entries — represented here as `field.<fieldId>` rather than as one more member
// of the static union. Binary custom fields, like the two toggles above,
// never become a `dimension` value at all — they stay direct controls.
type StaticDimensionKey = 'status' | 'stage' | 'priority' | 'position' | 'year' | 'tag' | 'subject' | 'committee' | 'state'
type CustomFieldDimensionKey = `field.${string}`
type DimensionKey = StaticDimensionKey | CustomFieldDimensionKey

function isCustomFieldDimension(key: DimensionKey): key is CustomFieldDimensionKey {
  return key.startsWith('field.')
}
function customFieldDimensionKey(fieldId: string): CustomFieldDimensionKey {
  return `field.${fieldId}`
}
function customFieldIdFromDimension(key: CustomFieldDimensionKey): string {
  return key.slice('field.'.length)
}

function SheetChip({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: fontSize.sm,
        padding: '7px 14px',
        borderRadius: radius.xl,
        border: '1px solid',
        cursor: 'pointer',
        background: active ? color.linkBlue : color.white,
        color: active ? color.textOnFill : color.textSlate,
        borderColor: active ? color.linkBlue : color.borderDefault,
        fontWeight: active ? fontWeight.semibold : fontWeight.normal,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        // A long label wraps inside the chip rather than widening the list past a phone's width.
        maxWidth: '100%',
        textAlign: 'left',
        overflowWrap: 'anywhere',
      }}
    >
      {label}
      {count !== undefined && (
        <span style={{
          fontSize: fontSize.sm,
          color: active ? `color-mix(in srgb, ${color.textOnFill} 70%, transparent)` : color.textMuted,
          background: active ? `color-mix(in srgb, ${color.textOnFill} 15%, transparent)` : color.surfaceMuted,
          padding: '1px 6px',
          borderRadius: radius.lg,
        }}>
          {count.toLocaleString()}
        </span>
      )}
    </button>
  )
}

function SectionLabel({ title }: { title: string }) {
  return (
    <div style={{
      fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textMuted,
      textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
    }}>
      {title}
    </div>
  )
}

// A level-1 row naming one dimension, with a count of its currently-selected
// options (so the user can see where their active filters are without
// opening anything) and a chevron indicating it drills into level 2.
function DimensionRow({ label, selectedCount, onClick, buttonRef }: { label: string; selectedCount: number; onClick: () => void; buttonRef?: (el: HTMLButtonElement | null) => void }) {
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 0', background: 'none', border: 'none', borderBottom: `1px solid ${color.borderDefault}`,
        cursor: 'pointer', textAlign: 'left',
      }}
    >
      <span style={{ fontSize: fontSize.base, fontWeight: fontWeight.medium, color: color.textPrimary }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {selectedCount > 0 && (
          <span style={COUNT_BADGE}>{selectedCount.toLocaleString()}</span>
        )}
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" aria-hidden="true">
          <path d="M1 1l6 6-6 6" style={{ stroke: color.textMuted }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Back to filters"
      style={{
        display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
        cursor: 'pointer', padding: 0, color: color.linkBlue, fontSize: fontSize.base, fontWeight: fontWeight.medium,
      }}
    >
      <svg width="8" height="14" viewBox="0 0 8 14" fill="none" aria-hidden="true">
        <path d="M7 1L1 7l6 6" style={{ stroke: color.linkBlue }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

// Level 1 <-> level 2 replaces the sheet's content in place — there's no page
// navigation, browser history entry, or route change to carry a keyboard or
// screen-reader user's position across the transition, so it has to be done
// by hand. Mirrors the desktop FilterDropdown's "move focus into what just
// opened" convention (FilterPanel.tsx): drilling in moves focus onto the
// level-2 heading (a real <h2>, focusable via tabIndex={-1}), so a screen
// reader announces the dimension you just entered; drilling out moves focus
// back onto the row you drilled in from, so tabbing/arrowing resumes exactly
// where it left off instead of resetting to the top of the list.
function useDrilldownFocus(dimension: DimensionKey | null, isOpen: boolean) {
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const rowRefs = useRef<Partial<Record<DimensionKey, HTMLButtonElement | null>>>({})
  const lastDimensionRef = useRef<DimensionKey | null>(null)

  useEffect(() => {
    if (!isOpen) return
    if (dimension !== null) {
      lastDimensionRef.current = dimension
      headingRef.current?.focus()
    } else if (lastDimensionRef.current !== null) {
      rowRefs.current[lastDimensionRef.current]?.focus()
      lastDimensionRef.current = null
    }
  }, [dimension, isOpen])

  return {
    headingRef,
    rowRef: (key: DimensionKey) => (el: HTMLButtonElement | null) => { rowRefs.current[key] = el },
    clearHistory: () => { lastDimensionRef.current = null },
  }
}

export function FilterSheet({
  isOpen, onClose,
  status, stage, priority, position, tag, subject, year, state, minRelevance, myBills, search = '',
  isAdmin, newMatches, newMatchesCount, unvoted, unvotedCount, drafts, draftCount, hasDrafts, uniqueStates, isMultiState,
  match, onMatchChange,
  statusOptions, stageOptions, statusGroups, priorityOptions, positionOptions, tagOptions, subjectGroups, yearOptions, totalYearCount, stateOptions,
  committee = [], committeeScope = 'any', committeeGroups = [], onCommitteeChange = () => {}, onCommitteeScopeChange = () => {},
  customFieldDefs, field, onFieldChange,
  onStatusChange, onStageChange, onPriorityChange, onPositionChange, onTagChange, onSubjectChange, onYearChange, onStateChange,
  onMinRelevanceChange, onMyBillsChange, onNewMatchesChange, onUnvotedChange, onDraftsChange,
  onClearAll, counts,
}: FilterSheetProps) {
  useEffect(() => {
    if (!isOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [isOpen])

  // The sheet always opens on the dimension list (level 1), never mid-drill —
  // reset whenever it transitions from closed to open.
  const stageUseful = useStageFilterUseful()
  const [dimension, setDimension] = useState<DimensionKey | null>(null)
  const { headingRef, rowRef, clearHistory } = useDrilldownFocus(dimension, isOpen)
  useEffect(() => {
    if (isOpen) {
      setDimension(null)
      // A stale "drilled in from X" record from a previous open must not
      // steal focus back to row X the moment this one lands on level 1.
      clearHistory()
    }
    // clearHistory is stable (from a ref-backed hook) and intentionally
    // excluded so this only reacts to isOpen transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Track the relevance thumb locally so it moves instantly while dragging, but
  // only commit (which drives the bill query) on release — one fetch per drag,
  // not one per step.
  const [relevanceDraft, setRelevanceDraft] = useState(minRelevance)
  useEffect(() => { setRelevanceDraft(minRelevance) }, [minRelevance])
  const commitRelevance = () => {
    if (relevanceDraft !== minRelevance) onMinRelevanceChange(relevanceDraft)
  }

  if (!isOpen) return null

  const filterDimensionCtx: FilterDimensionContext = { uniqueStates, isAdmin, isMultiState, hasDrafts: hasDrafts ?? false, draftsActive: drafts, newMatchesActive: newMatches, stageUseful, stageActive: stage.length > 0 }
  // Where Stage was offered, Status is grouped under stage headings when the API says which stage each status is in.
  const stageOffered = isStatusGroupedByStage(filterDimensionCtx)
  const groupedStatus = stageOffered && statusGroups ? statusGroups : null
  const stateVisible = isFilterDimensionVisible('state', filterDimensionCtx)
  const newMatchesVisible = isFilterDimensionVisible('newMatches', filterDimensionCtx)
  const draftsVisible = isFilterDimensionVisible('drafts', filterDimensionCtx)

  // The one list of active filters, read from the shared module as the page's badge, Reset, chips, and summary read
  // it: this sheet holds the filter as separate props, so it gathers them into the shared value and asks. A filter
  // this instance does not offer is left out by the registry.
  const activeList = activeFilters(
    withBillFilter({
      status, stage, priority, position, tag, year,
      state,
      subject: subject.flatMap(v => decodeSubjectFilter(v) ?? []),
      committee, committeeScope,
      minRelevance: minRelevance > 0 ? minRelevance : null,
      myBills, unvoted, newMatches, drafts, field, search,
    }),
    { hidden: hiddenFilterDimensions(filterDimensionCtx) },
  )

  // A heading's checkbox toggles its whole stage: the stage, and the statuses too when unchecking clears ones chosen one by one.
  function toggleStage(group: StatusStageGroup) {
    const next = toggleStageSelection(group, status, stage)
    if (next.stage.length !== stage.length) onStageChange(next.stage)
    if (next.status.length !== status.length) onStatusChange(next.status)
  }

  function toggleItem(arr: string[], val: string, setter: (v: string[]) => void) {
    setter(arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val])
  }

  // Every drill-down dimension's heading pulls its text from the shared
  // registry (lib/filterDimensions.ts) — this component may not hard-code
  // any of these labels itself.
  const STATIC_DIMENSION_LABELS: Record<StaticDimensionKey, string> = {
    state: filterDimensionLabel('state'),
    status: filterDimensionLabel('status'),
    stage: STAGE_FILTER_LABEL,
    priority: filterDimensionLabel('priority'),
    position: filterDimensionLabel('position'),
    year: filterDimensionLabel('year'),
    tag: filterDimensionLabel('tag'),
    subject: filterDimensionLabel('subject'),
    committee: filterDimensionLabel('committee'),
  }

  // Which custom field types are filterable, and what control each gets, is
  // decided once in lib/customFieldFilters.ts and shared with the desktop
  // toolbar (and the parity test) — this component may not re-derive it.
  const filterableCFs = filterableCustomFields(customFieldDefs)
  const toggleCustomFields = filterableCFs.filter(cf => cf.kind === 'toggle')
  const optionsCustomFields = filterableCFs.filter(cf => cf.kind === 'options')

  // A custom field's name IS its label — unlike the nine static dimensions,
  // there's no separate registry entry to source it from (custom fields are
  // tenant-defined, not fixed vocabulary).
  function dimensionLabel(key: DimensionKey): string {
    if (isCustomFieldDimension(key)) {
      const fieldId = customFieldIdFromDimension(key)
      return filterableCFs.find(cf => cf.def.id === fieldId)?.def.name ?? ''
    }
    return STATIC_DIMENSION_LABELS[key]
  }

  const activeDimensionCustomField = dimension !== null && isCustomFieldDimension(dimension)
    ? filterableCFs.find(cf => cf.def.id === customFieldIdFromDimension(dimension))
    : undefined

  const yearVisible = (totalYearCount ?? yearOptions.length) > 0

  // Same groups (and same AND/OR operator) desktop shows in its active-chip
  // row above the sticky header (index.tsx) — built from this component's
  // own props rather than threaded in whole, since match/onMatchChange
  // are the only two new props this task adds (see FilterSheetProps above).
  // Removal callbacks translate directly to this component's existing
  // onXChange setters; the sheet needs no additional wiring from index.tsx.
  const activeFilterGroups = buildActiveFilterGroups({
    state, status, stage, position, priority,
    year: year.map(Number),
    tag, subject, committee, committeeScope, field, minRelevance,
    committeeLabels: committeeLabelsOf(committeeGroups),
    positionOptions,
    customFieldDefs,
    isMultiState,
    active: activeList,
    onRemoveState: s => onStateChange(state.filter(x => x !== s)),
    onRemoveStatus: s => onStatusChange(status.filter(x => x !== s)),
    onRemoveStage: s => onStageChange(stage.filter(x => x !== s)),
    onRemovePosition: p => onPositionChange(position.filter(x => x !== p)),
    onRemovePriority: p => onPriorityChange(priority.filter(x => x !== p)),
    onRemoveYear: y => onYearChange(year.filter(v => v !== String(y))),
    onRemoveTag: t => onTagChange(tag.filter(x => x !== t)),
    onRemoveSubject: v => onSubjectChange(subject.filter(x => x !== v)),
    onRemoveCommittee: v => onCommitteeChange(committee.filter(x => x !== v)),
    onRemoveField: (fieldId, v) => onFieldChange(fieldId, (field[fieldId] ?? []).filter(x => x !== v)),
    onRemoveMinRelevance: () => onMinRelevanceChange(0),
  })

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          zIndex: 400,
        }}
      />
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: color.white,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        zIndex: 401,
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{ padding: '12px 0 0', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 36, height: 4, background: color.borderDefault, borderRadius: radius.xs }} />
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 20px 8px',
        }}>
          {dimension === null ? (
            <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: color.textPrimary }}>Filter Bills</h2>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <BackButton onClick={() => setDimension(null)} />
              {/* Focus lands here on drill-in (see useDrilldownFocus) so a
                  screen reader announces the dimension by name — the only
                  other change on screen is which options are listed below,
                  which nothing would otherwise surface. tabIndex={-1} makes
                  a non-interactive heading focusable programmatically without
                  adding it to the tab order. */}
              <h2 ref={headingRef} tabIndex={-1} style={{ margin: 0, fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: color.textPrimary, outline: 'none' }}>
                {dimensionLabel(dimension)}
              </h2>
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {activeList.length > 0 && (
              <button
                onClick={onClearAll}
                style={{ fontSize: fontSize.sm, color: color.linkBlue, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Reset filters
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close filters"
              style={{ fontSize: fontSize.xxxl, color: color.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
            >
              ×
            </button>
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 20px 32px' }}>
          {dimension === null && (
            <>
              <div style={{ marginBottom: 20 }}>
                <SectionLabel title={filterDimensionLabel('myBills')} />
                <SheetChip
                  label={filterDimensionLabel('myBills')}
                  active={myBills}
                  onClick={() => onMyBillsChange(!myBills)}
                />
              </div>

              {/* Admin-only unless its filter is on, same gate as desktop's "New matches" toggle
                  (see lib/filterDimensions.ts) — a toggle, not a list of
                  options, so it stays a direct control here too rather than
                  becoming a drill-down target. */}
              {newMatchesVisible && (
                <div style={{ marginBottom: 20 }}>
                  <SectionLabel title={filterDimensionLabel('newMatches')} />
                  <SheetChip
                    label={filterDimensionLabel('newMatches')}
                    active={newMatches}
                    count={isAdmin ? (newMatchesCount ?? 0) : undefined}
                    onClick={() => onNewMatchesChange(!newMatches)}
                  />
                </div>
              )}

              {/* Not yet voted — always visible, same as My bills (see
                  lib/filterDimensions.ts). This is the mobile drill-down
                  sheet's only affordance for the state: it's reachable here
                  even though it has no dedicated mobile control anywhere
                  else, unlike the desktop toolbar's FilterToggle cluster. */}
              <div style={{ marginBottom: 20 }}>
                <SectionLabel title={filterDimensionLabel('unvoted')} />
                <SheetChip
                  label={filterDimensionLabel('unvoted')}
                  active={unvoted}
                  count={unvotedCount ?? 0}
                  onClick={() => onUnvotedChange(!unvoted)}
                />
              </div>

              {/* Drafts — hidden only when the tenant has no drafts at all,
                  never because the active filters exclude them (see
                  lib/filterDimensions.ts). Same toggle treatment as My bills /
                  New matches / Not yet voted: a workflow scope, not a list of
                  options. */}
              {draftsVisible && (
                <div style={{ marginBottom: 20 }}>
                  <SectionLabel title={filterDimensionLabel('drafts')} />
                  <SheetChip
                    label={filterDimensionLabel('drafts')}
                    active={drafts}
                    count={draftCount ?? 0}
                    onClick={() => onDraftsChange(!drafts)}
                  />
                </div>
              )}

              {/* Scope/bill-fact separator — mirrors desktop's vertical rule
                  (index.tsx's `data-testid="scope-separator"`) adapted to this
                  sheet's vertical layout. My bills / New matches / Not yet
                  voted / Drafts above are workflow SCOPE (where the bill sits
                  in our handling, not what the bill is), while the binary
                  custom fields below are bill FACTS rendered as byte-identical
                  SheetChip controls — mobile is exactly the surface where that
                  distinction is hardest to infer without something marking
                  the boundary. */}
              {toggleCustomFields.length > 0 && (
                <div
                  data-testid="scope-separator"
                  aria-hidden="true"
                  style={{ height: 1, margin: '0 0 20px', background: color.borderDefault }}
                />
              )}

              {/* Binary custom fields — a direct toggle, same treatment as
                  My bills / New matches above (see lib/customFieldFilters.ts).
                  Zero filterable binary fields renders nothing here at all. */}
              {toggleCustomFields.map(({ def }) => {
                const isActive = (field[def.id] ?? []).includes('1')
                return (
                  <div key={def.id} style={{ marginBottom: 20 }}>
                    <SectionLabel title={def.name} />
                    <SheetChip
                      label={def.name}
                      active={isActive}
                      count={counts?.field?.[def.id]?.['1'] ?? 0}
                      onClick={() => onFieldChange(def.id, isActive ? [] : ['1'])}
                    />
                  </div>
                )
              })}

              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Min. Relevance
                  </div>
                  <span style={{ fontSize: fontSize.sm, fontWeight: relevanceDraft > 0 ? fontWeight.semibold : fontWeight.normal, color: relevanceDraft > 0 ? color.linkBlue : color.textMuted }}>
                    {relevanceDraft === 0 ? 'Any' : relevanceDraft < 10 ? `${relevanceDraft}+` : '10'}
                  </span>
                </div>
                <style>{`
                  input[type=range].sheet-relevance-slider { -webkit-appearance: none; appearance: none; background: transparent; height: 20px; width: 100%; }
                  input[type=range].sheet-relevance-slider::-webkit-slider-runnable-track {
                    background: linear-gradient(to right, ${color.accentAmber} 0%, ${color.accentAmber} ${(relevanceDraft / 10) * 100}%, ${color.borderDefault} ${(relevanceDraft / 10) * 100}%, ${color.borderDefault} 100%);
                    height: 5px; border-radius: 4px;
                  }
                  input[type=range].sheet-relevance-slider::-webkit-slider-thumb {
                    -webkit-appearance: none; width: 20px; height: 20px; background: ${relevanceDraft > 0 ? color.accentAmber : color.borderStrong};
                    border-radius: 50%; margin-top: -7.5px; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.2);
                  }
                  input[type=range].sheet-relevance-slider::-moz-range-track { background: ${color.borderDefault}; height: 5px; border-radius: 4px; }
                  input[type=range].sheet-relevance-slider::-moz-range-progress { background: ${color.accentAmber}; height: 5px; border-radius: 4px 0 0 4px; }
                  input[type=range].sheet-relevance-slider::-moz-range-thumb { background: ${relevanceDraft > 0 ? color.accentAmber : color.borderStrong}; border-radius: 50%; width: 20px; height: 20px; border: none; cursor: pointer; }
                `}</style>
                <input
                  type="range"
                  className="sheet-relevance-slider"
                  min={0}
                  max={10}
                  step={1}
                  value={relevanceDraft}
                  onChange={e => setRelevanceDraft(Number(e.target.value))}
                  onPointerUp={commitRelevance}
                  onKeyUp={commitRelevance}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: fontSize.xs, color: color.borderStrong, marginTop: 2 }}>
                  <span>Any</span>
                  <span>10</span>
                </div>
              </div>

              {/* Active bill-fact filter chips, with the AND/OR operator
                  between groups — mirrors desktop's chip row (index.tsx)
                  exactly, including the interleaving rule: one operator
                  between each adjacent pair of groups, none before the first
                  or after the last, none at all with a single group. Workflow-
                  scope state (My bills / New matches / Not yet voted / Drafts)
                  is never in these groups by construction
                  (buildActiveFilterGroups), so it never sits between
                  operators — it's rendered as the pills above instead. */}
              {activeFilterGroups.length > 0 && (
                <div data-testid="sheet-active-filter-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 20, alignItems: 'center' }}>
                  {activeFilterGroups.flatMap((g, i) => i === 0
                    ? g.chips
                    : [<GroupOperator key={`op-${g.key}`} match={match} onToggle={() => onMatchChange(match === 'any' ? 'all' : 'any')} />, ...g.chips])}
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <SectionLabel title="Filters" />
                {stateVisible && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.state} selectedCount={state.length} onClick={() => setDimension('state')} buttonRef={rowRef('state')} />
                )}
                {(groupedStatus ? groupedStatus.length > 0 : statusOptions.length > 0) && (
                  <DimensionRow
                    label={STATIC_DIMENSION_LABELS.status}
                    selectedCount={status.length + (groupedStatus ? stage.length : 0)}
                    onClick={() => setDimension('status')}
                    buttonRef={rowRef('status')}
                  />
                )}
                {stageOffered && !groupedStatus && stageOptions.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.stage} selectedCount={stage.length} onClick={() => setDimension('stage')} buttonRef={rowRef('stage')} />
                )}
                {priorityOptions.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.priority} selectedCount={priority.length} onClick={() => setDimension('priority')} buttonRef={rowRef('priority')} />
                )}
                {positionOptions.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.position} selectedCount={position.length} onClick={() => setDimension('position')} buttonRef={rowRef('position')} />
                )}
                {yearVisible && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.year} selectedCount={year.length} onClick={() => setDimension('year')} buttonRef={rowRef('year')} />
                )}
                {tagOptions.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.tag} selectedCount={tag.length} onClick={() => setDimension('tag')} buttonRef={rowRef('tag')} />
                )}
                {subjectGroups.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.subject} selectedCount={subject.length} onClick={() => setDimension('subject')} buttonRef={rowRef('subject')} />
                )}
                {(committeeGroups.length > 0 || committee.length > 0) && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.committee} selectedCount={committee.length} onClick={() => setDimension('committee')} buttonRef={rowRef('committee')} />
                )}
                {/* Dropdown custom fields — a drill-down dimension like Status
                    or Tags, dynamic per tenant (see lib/customFieldFilters.ts). */}
                {optionsCustomFields.map(({ def }) => {
                  const cfDimension = customFieldDimensionKey(def.id)
                  return (
                    <DimensionRow
                      key={def.id}
                      label={def.name}
                      selectedCount={(field[def.id] ?? []).length}
                      onClick={() => setDimension(cfDimension)}
                      buttonRef={rowRef(cfDimension)}
                    />
                  )
                })}
              </div>
            </>
          )}

          {dimension === 'state' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {stateOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={state.includes(opt.value)}
                  onClick={() => toggleItem(state, opt.value, onStateChange)}
                  count={counts?.state?.[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'status' && groupedStatus && (
            <div>
              {groupedStatus.map(group => {
                const check = stageCheckState(group, status, stage)
                const lit = check !== 'off'
                return (
                  <div key={group.stage ?? 'other'} style={{ marginBottom: 16 }}>
                    <h3 style={{ margin: '0 0 8px', fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: color.textPrimary }}>
                      {group.stage !== null ? (
                        // A heading's checkbox selects the whole stage, and says so; Other has no stage to select, so it is plain text.
                        <label
                          title={STAGE_HEADING_HINT}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', textAlign: 'left', cursor: 'pointer',
                            padding: '6px 0', borderBottom: `2px solid ${check === 'on' ? color.linkBlue : 'transparent'}`,
                            font: 'inherit', color: lit ? color.linkBlue : 'inherit', overflowWrap: 'anywhere',
                          }}
                        >
                          <TriStateCheckbox state={check} onToggle={() => toggleStage(group)} />
                          {group.label}
                          {group.count !== null && <span style={COUNT_BADGE}>{group.count.toLocaleString()}</span>}
                        </label>
                      ) : group.label}
                    </h3>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {group.options.map(opt => (
                        <SheetChip
                          key={opt.value}
                          label={opt.label}
                          active={status.includes(opt.value)}
                          onClick={() => toggleItem(status, opt.value, onStatusChange)}
                          count={counts?.status[opt.value] ?? 0}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {dimension === 'status' && !groupedStatus && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {statusOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={status.includes(opt.value)}
                  onClick={() => toggleItem(status, opt.value, onStatusChange)}
                  count={counts?.status[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'stage' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {stageOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={stage.includes(opt.value)}
                  onClick={() => toggleItem(stage, opt.value, onStageChange)}
                  count={counts?.stage?.[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'priority' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {priorityOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={priority.includes(opt.value)}
                  onClick={() => toggleItem(priority, opt.value, onPriorityChange)}
                  count={counts?.priority[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'position' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {positionOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={position.includes(opt.value)}
                  onClick={() => toggleItem(position, opt.value, onPositionChange)}
                  count={counts?.position[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'year' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {yearOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={year.includes(opt.value)}
                  onClick={() => toggleItem(year, opt.value, onYearChange)}
                  count={counts?.year[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'tag' && (
            <FilterSheetVirtualList
              ariaLabel={STATIC_DIMENSION_LABELS.tag}
              searchPlaceholder="Search tags…"
              groups={[{ key: 'tag', options: tagOptions.map(t => ({ value: t, label: t, count: counts?.tag[t] ?? 0 })) }]}
              selected={tag}
              onToggle={(value) => toggleItem(tag, value, onTagChange)}
            />
          )}

          {/* Subject vocabularies aren't comparable across states (see
              useBillFilters' subjectGroups), so this section groups its
              options under a state heading whenever more than one state is
              present — handled inside FilterSheetVirtualList. */}
          {dimension === 'subject' && (
            <FilterSheetVirtualList
              ariaLabel={STATIC_DIMENSION_LABELS.subject}
              searchPlaceholder="Search subjects…"
              groups={subjectGroups.map(group => ({ key: group.state, heading: group.state, options: group.options }))}
              selected={subject}
              onToggle={(value) => toggleItem(subject, value, onSubjectChange)}
              limitSubjects
            />
          )}

          {/* Committees (#471): the scope switch, then each state's committees by count. */}
          {dimension === 'committee' && (
            <div>
              <CommitteeScopeSwitch scope={committeeScope} onScopeChange={onCommitteeScopeChange} name="committee-scope-sheet" style={{ borderRadius: radius.md }} />
              {committeeGroups.map(group => (
                <div key={group.state} style={{ marginTop: 8 }}>
                  {isMultiState && <SectionLabel title={group.state} />}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {group.options.map(opt => (
                      <SheetChip
                        key={opt.value}
                        label={opt.label}
                        active={committee.includes(opt.value)}
                        onClick={() => toggleItem(committee, opt.value, onCommitteeChange)}
                        count={opt.count}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Dropdown custom field options (level 2) — same chip-list
              treatment as Status/Priority/Position/Session above, just keyed
              by the field's id instead of a fixed dimension name. */}
          {activeDimensionCustomField && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(activeDimensionCustomField.def.options ?? []).map(opt => {
                const selected = field[activeDimensionCustomField.def.id] ?? []
                return (
                  <SheetChip
                    key={opt}
                    label={opt}
                    active={selected.includes(opt)}
                    onClick={() => toggleItem(selected, opt, v => onFieldChange(activeDimensionCustomField.def.id, v))}
                    count={counts?.field?.[activeDimensionCustomField.def.id]?.[opt] ?? 0}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
