import { useEffect, useRef, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { COUNT_BADGE } from '../lib/chipStyles'
import type { SubjectGroup } from '../pages/BillList/FilterPanel'
import type { CustomFieldDef } from '../pages/BillList/types'
import { FilterSheetVirtualList } from './FilterSheetVirtualList'
import { filterDimensionLabel, isFilterDimensionVisible, type FilterDimensionContext } from '../lib/filterDimensions'
import { filterableCustomFields } from '../lib/customFieldFilters'
import { buildActiveFilterGroups } from '../pages/BillList/activeFilterGroups'
import { GroupOperator } from '../pages/BillList/GroupOperator'

interface FilterSheetProps {
  isOpen: boolean
  onClose: () => void
  statuses: string[]
  priorities: string[]
  positions: string[]
  tags: string[]
  subjects: string[]
  sessions: string[]
  states: string[]
  minRelevance: number
  myBills: boolean
  /** Admin-gates the New matches toggle — same check as desktop's `isAdmin`. */
  isAdmin: boolean
  newMatches: boolean
  newMatchesCount?: number
  unvotedOnly: boolean
  unvotedCount?: number
  /** Whether active bill-fact filter groups combine with AND (false, the
   *  default) or OR (true) — same state desktop reads/writes as `f.matchAny`
   *  / `f.setMatchAny`. Rendered between groups in this sheet's active-chip
   *  summary via `GroupOperator`, identically to desktop's chip row. */
  matchAny: boolean
  onMatchAnyChange: (v: boolean) => void
  /** Distinct states the tenant's bills span — same value desktop passes as
   *  `f.uniqueStates`, used only to decide whether the State dimension
   *  appears (see lib/filterDimensions.ts). */
  uniqueStates: string[]
  /** The tenant's bills span more than one state — same value as desktop's
   *  `f.isMultiState`, gated by `knownStates.size > 1`. */
  isMultiState: boolean
  statusOptions: { value: string; label: string }[]
  priorityOptions: { value: string; label: string }[]
  positionOptions: { value: string; label: string }[]
  tagOptions: string[]
  subjectGroups: SubjectGroup[]
  sessionOptions: { value: string; label: string }[]
  totalSessionCount?: number
  stateOptions: { value: string; label: string }[]
  /** All tenant custom field defs (unfiltered) — same value desktop reads as
   *  `customFieldDefs`. This component decides filterability itself via
   *  lib/customFieldFilters.ts, mirroring desktop exactly. */
  customFieldDefs: CustomFieldDef[]
  /** Currently-selected values per custom field id — same shape as desktop's
   *  `f.cfFilters`. */
  cfFilters: Record<string, string[]>
  onCfFilterChange: (fieldId: string, values: string[]) => void
  onStatusChange: (v: string[]) => void
  onPriorityChange: (v: string[]) => void
  onPositionChange: (v: string[]) => void
  onTagChange: (v: string[]) => void
  onSubjectChange: (v: string[]) => void
  onSessionChange: (v: string[]) => void
  onStateChange: (v: string[]) => void
  onMinRelevanceChange: (v: number) => void
  onMyBillsChange: (v: boolean) => void
  onNewMatchesChange: (v: boolean) => void
  onUnvotedOnlyChange: (v: boolean) => void
  onClearAll: () => void
  counts?: {
    status: Record<string, number>
    priority: Record<string, number>
    position: Record<string, number>
    session: Record<string, number>
    tags: Record<string, number>
    state?: Record<string, number>
    customFields?: Record<string, Record<string, number>>
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
// entries — represented here as `cf:<fieldId>` rather than as one more member
// of the static union. Binary custom fields, like the two toggles above,
// never become a `dimension` value at all — they stay direct controls.
type StaticDimensionKey = 'status' | 'priority' | 'position' | 'session' | 'tags' | 'subjects' | 'state'
type CustomFieldDimensionKey = `cf:${string}`
type DimensionKey = StaticDimensionKey | CustomFieldDimensionKey

function isCustomFieldDimension(key: DimensionKey): key is CustomFieldDimensionKey {
  return key.startsWith('cf:')
}
function customFieldDimensionKey(fieldId: string): CustomFieldDimensionKey {
  return `cf:${fieldId}`
}
function customFieldIdFromDimension(key: CustomFieldDimensionKey): string {
  return key.slice('cf:'.length)
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
        color: active ? color.white : color.textSlate,
        borderColor: active ? color.linkBlue : color.borderDefault,
        fontWeight: active ? fontWeight.semibold : fontWeight.normal,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {label}
      {count !== undefined && (
        <span style={{
          fontSize: fontSize.sm,
          color: active ? 'rgba(255,255,255,0.7)' : color.textMuted,
          background: active ? 'rgba(255,255,255,0.15)' : color.surfaceMuted,
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
          <path d="M1 1l6 6-6 6" stroke={color.textMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
        <path d="M7 1L1 7l6 6" stroke={color.linkBlue} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
  statuses, priorities, positions, tags, subjects, sessions, states, minRelevance, myBills,
  isAdmin, newMatches, newMatchesCount, unvotedOnly, unvotedCount, uniqueStates, isMultiState,
  matchAny, onMatchAnyChange,
  statusOptions, priorityOptions, positionOptions, tagOptions, subjectGroups, sessionOptions, totalSessionCount, stateOptions,
  customFieldDefs, cfFilters, onCfFilterChange,
  onStatusChange, onPriorityChange, onPositionChange, onTagChange, onSubjectChange, onSessionChange, onStateChange,
  onMinRelevanceChange, onMyBillsChange, onNewMatchesChange, onUnvotedOnlyChange,
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

  const filterDimensionCtx: FilterDimensionContext = { uniqueStates, isAdmin, isMultiState }
  const stateVisible = isFilterDimensionVisible('state', filterDimensionCtx)
  const newMatchesVisible = isFilterDimensionVisible('newMatches', filterDimensionCtx)

  // Must mirror useBillFilters' totalActiveFilters (the mobile filter
  // button's badge count) term for term — a mismatch is exactly the bug that
  // orphaned `unvoted` on mobile (see task-7-report.md, Critical 1): the
  // button badge counted it, this sheet's own "Reset filters" gate didn't.
  const totalActive = statuses.length + priorities.length + positions.length + tags.length + subjects.length + sessions.length + states.length + (minRelevance > 0 ? 1 : 0) + (myBills ? 1 : 0) + (unvotedOnly ? 1 : 0) + (newMatchesVisible && newMatches ? 1 : 0) + Object.values(cfFilters).reduce((sum, v) => sum + v.length, 0)

  function toggleItem(arr: string[], val: string, setter: (v: string[]) => void) {
    setter(arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val])
  }

  // Every drill-down dimension's heading pulls its text from the shared
  // registry (lib/filterDimensions.ts) — this component may not hard-code
  // any of these labels itself.
  const STATIC_DIMENSION_LABELS: Record<StaticDimensionKey, string> = {
    state: filterDimensionLabel('state'),
    status: filterDimensionLabel('status'),
    priority: filterDimensionLabel('priority'),
    position: filterDimensionLabel('position'),
    session: filterDimensionLabel('session'),
    tags: filterDimensionLabel('tags'),
    subjects: filterDimensionLabel('subjects'),
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

  const sessionVisible = (totalSessionCount ?? sessionOptions.length) > 0

  // Same groups (and same AND/OR operator) desktop shows in its active-chip
  // row above the sticky header (index.tsx) — built from this component's
  // own props rather than threaded in whole, since matchAny/onMatchAnyChange
  // are the only two new props this task adds (see FilterSheetProps above).
  // Removal callbacks translate directly to this component's existing
  // onXChange setters; the sheet needs no additional wiring from index.tsx.
  const activeFilterGroups = buildActiveFilterGroups({
    filterStates: states,
    filterStatuses: statuses,
    filterPositions: positions,
    filterPriorities: priorities,
    filterYears: sessions.map(Number),
    selectedTags: tags,
    selectedSubjects: subjects,
    cfFilters,
    filterMinRelevance: minRelevance,
    positionOptions,
    customFieldDefs,
    isMultiState,
    onRemoveState: s => onStateChange(states.filter(x => x !== s)),
    onRemoveStatus: s => onStatusChange(statuses.filter(x => x !== s)),
    onRemovePosition: p => onPositionChange(positions.filter(x => x !== p)),
    onRemovePriority: p => onPriorityChange(priorities.filter(x => x !== p)),
    onRemoveYear: y => onSessionChange(sessions.filter(s => s !== String(y))),
    onRemoveTag: tag => onTagChange(tags.filter(x => x !== tag)),
    onRemoveSubject: subject => onSubjectChange(subjects.filter(x => x !== subject)),
    onRemoveCf: (fieldId, v) => onCfFilterChange(fieldId, (cfFilters[fieldId] ?? []).filter(x => x !== v)),
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
            {totalActive > 0 && (
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

              {/* Admin-only, same gate as desktop's "New matches" toggle
                  (see lib/filterDimensions.ts) — a toggle, not a list of
                  options, so it stays a direct control here too rather than
                  becoming a drill-down target. */}
              {newMatchesVisible && (
                <div style={{ marginBottom: 20 }}>
                  <SectionLabel title={filterDimensionLabel('newMatches')} />
                  <SheetChip
                    label={filterDimensionLabel('newMatches')}
                    active={newMatches}
                    count={newMatchesCount ?? 0}
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
                  active={unvotedOnly}
                  count={unvotedCount ?? 0}
                  onClick={() => onUnvotedOnlyChange(!unvotedOnly)}
                />
              </div>

              {/* Scope/bill-fact separator — mirrors desktop's vertical rule
                  (index.tsx's `data-testid="scope-separator"`) adapted to this
                  sheet's vertical layout. My bills / New matches / Not yet
                  voted above are viewer SCOPE (who's looking, not what the
                  bill is), while the binary custom fields below are bill
                  FACTS rendered as byte-identical SheetChip controls — mobile
                  is exactly the surface where that distinction is hardest to
                  infer without something marking the boundary. */}
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
                const isActive = (cfFilters[def.id] ?? []).includes('1')
                return (
                  <div key={def.id} style={{ marginBottom: 20 }}>
                    <SectionLabel title={def.name} />
                    <SheetChip
                      label={def.name}
                      active={isActive}
                      count={counts?.customFields?.[def.id]?.['1'] ?? 0}
                      onClick={() => onCfFilterChange(def.id, isActive ? [] : ['1'])}
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
                  or after the last, none at all with a single group. Viewer-
                  scope state (My bills / New matches / Not yet voted) is
                  never in these groups by construction (buildActiveFilterGroups),
                  so it never sits between operators — it's rendered as the
                  pills above instead. */}
              {activeFilterGroups.length > 0 && (
                <div data-testid="sheet-active-filter-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 20, alignItems: 'center' }}>
                  {activeFilterGroups.flatMap((g, i) => i === 0
                    ? g.chips
                    : [<GroupOperator key={`op-${g.key}`} matchAny={matchAny} onToggle={() => onMatchAnyChange(!matchAny)} />, ...g.chips])}
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <SectionLabel title="Filters" />
                {stateVisible && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.state} selectedCount={states.length} onClick={() => setDimension('state')} buttonRef={rowRef('state')} />
                )}
                {statusOptions.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.status} selectedCount={statuses.length} onClick={() => setDimension('status')} buttonRef={rowRef('status')} />
                )}
                {priorityOptions.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.priority} selectedCount={priorities.length} onClick={() => setDimension('priority')} buttonRef={rowRef('priority')} />
                )}
                {positionOptions.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.position} selectedCount={positions.length} onClick={() => setDimension('position')} buttonRef={rowRef('position')} />
                )}
                {sessionVisible && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.session} selectedCount={sessions.length} onClick={() => setDimension('session')} buttonRef={rowRef('session')} />
                )}
                {tagOptions.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.tags} selectedCount={tags.length} onClick={() => setDimension('tags')} buttonRef={rowRef('tags')} />
                )}
                {subjectGroups.length > 0 && (
                  <DimensionRow label={STATIC_DIMENSION_LABELS.subjects} selectedCount={subjects.length} onClick={() => setDimension('subjects')} buttonRef={rowRef('subjects')} />
                )}
                {/* Dropdown custom fields — a drill-down dimension like Status
                    or Tags, dynamic per tenant (see lib/customFieldFilters.ts). */}
                {optionsCustomFields.map(({ def }) => {
                  const cfDimension = customFieldDimensionKey(def.id)
                  return (
                    <DimensionRow
                      key={def.id}
                      label={def.name}
                      selectedCount={(cfFilters[def.id] ?? []).length}
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
                  active={states.includes(opt.value)}
                  onClick={() => toggleItem(states, opt.value, onStateChange)}
                  count={counts?.state?.[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'status' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {statusOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={statuses.includes(opt.value)}
                  onClick={() => toggleItem(statuses, opt.value, onStatusChange)}
                  count={counts?.status[opt.value] ?? 0}
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
                  active={priorities.includes(opt.value)}
                  onClick={() => toggleItem(priorities, opt.value, onPriorityChange)}
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
                  active={positions.includes(opt.value)}
                  onClick={() => toggleItem(positions, opt.value, onPositionChange)}
                  count={counts?.position[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'session' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {sessionOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={sessions.includes(opt.value)}
                  onClick={() => toggleItem(sessions, opt.value, onSessionChange)}
                  count={counts?.session[opt.value] ?? 0}
                />
              ))}
            </div>
          )}

          {dimension === 'tags' && (
            <FilterSheetVirtualList
              ariaLabel={STATIC_DIMENSION_LABELS.tags}
              searchPlaceholder="Search tags…"
              groups={[{ key: 'tags', options: tagOptions.map(tag => ({ value: tag, label: tag, count: counts?.tags[tag] ?? 0 })) }]}
              selected={tags}
              onToggle={(value) => toggleItem(tags, value, onTagChange)}
            />
          )}

          {/* Subject vocabularies aren't comparable across states (see
              useBillFilters' subjectGroups), so this section groups its
              options under a state heading whenever more than one state is
              present — handled inside FilterSheetVirtualList. */}
          {dimension === 'subjects' && (
            <FilterSheetVirtualList
              ariaLabel={STATIC_DIMENSION_LABELS.subjects}
              searchPlaceholder="Search subjects…"
              groups={subjectGroups.map(group => ({ key: group.state, heading: group.state, options: group.options }))}
              selected={subjects}
              onToggle={(value) => toggleItem(subjects, value, onSubjectChange)}
            />
          )}

          {/* Dropdown custom field options (level 2) — same chip-list
              treatment as Status/Priority/Position/Session above, just keyed
              by the field's id instead of a fixed dimension name. */}
          {activeDimensionCustomField && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(activeDimensionCustomField.def.options ?? []).map(opt => {
                const selected = cfFilters[activeDimensionCustomField.def.id] ?? []
                return (
                  <SheetChip
                    key={opt}
                    label={opt}
                    active={selected.includes(opt)}
                    onClick={() => toggleItem(selected, opt, v => onCfFilterChange(activeDimensionCustomField.def.id, v))}
                    count={counts?.customFields?.[activeDimensionCustomField.def.id]?.[opt] ?? 0}
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
