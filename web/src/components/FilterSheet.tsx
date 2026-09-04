import { useEffect, useRef, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { COUNT_BADGE } from '../lib/chipStyles'
import type { SubjectGroup } from '../pages/BillList/FilterPanel'
import { FilterSheetVirtualList } from './FilterSheetVirtualList'

interface FilterSheetProps {
  isOpen: boolean
  onClose: () => void
  statuses: string[]
  priorities: string[]
  positions: string[]
  tags: string[]
  subjects: string[]
  sessions: string[]
  minRelevance: number
  myBills: boolean
  statusOptions: { value: string; label: string }[]
  priorityOptions: { value: string; label: string }[]
  positionOptions: { value: string; label: string }[]
  tagOptions: string[]
  subjectGroups: SubjectGroup[]
  sessionOptions: { value: string; label: string }[]
  totalSessionCount?: number
  onStatusChange: (v: string[]) => void
  onPriorityChange: (v: string[]) => void
  onPositionChange: (v: string[]) => void
  onTagChange: (v: string[]) => void
  onSubjectChange: (v: string[]) => void
  onSessionChange: (v: string[]) => void
  onMinRelevanceChange: (v: number) => void
  onMyBillsChange: (v: boolean) => void
  onClearAll: () => void
  counts?: {
    status: Record<string, number>
    priority: Record<string, number>
    position: Record<string, number>
    session: Record<string, number>
    tags: Record<string, number>
  }
}

// The six drill-down dimensions. "My Bills" (a single toggle) and "Min.
// Relevance" (a slider) aren't included here — neither is a list of options
// to choose among, so both stay as direct controls on the dimension list
// (level 1) rather than becoming a drill-down target of their own.
type DimensionKey = 'status' | 'priority' | 'position' | 'session' | 'tags' | 'subjects'

function SheetChip({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button
      onClick={onClick}
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
  statuses, priorities, positions, tags, subjects, sessions, minRelevance, myBills,
  statusOptions, priorityOptions, positionOptions, tagOptions, subjectGroups, sessionOptions, totalSessionCount,
  onStatusChange, onPriorityChange, onPositionChange, onTagChange, onSubjectChange, onSessionChange,
  onMinRelevanceChange, onMyBillsChange,
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

  const totalActive = statuses.length + priorities.length + positions.length + tags.length + subjects.length + sessions.length + (minRelevance > 0 ? 1 : 0) + (myBills ? 1 : 0)

  function toggleItem(arr: string[], val: string, setter: (v: string[]) => void) {
    setter(arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val])
  }

  const DIMENSION_LABELS: Record<DimensionKey, string> = {
    status: 'Status', priority: 'Priority', position: 'Position',
    session: 'Session', tags: 'Topics', subjects: 'Subject',
  }

  const sessionVisible = (totalSessionCount ?? sessionOptions.length) > 0

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
                {DIMENSION_LABELS[dimension]}
              </h2>
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {totalActive > 0 && (
              <button
                onClick={onClearAll}
                style={{ fontSize: fontSize.sm, color: color.linkBlue, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Clear all
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
                <SectionLabel title="My Bills" />
                <SheetChip
                  label="My voted bills"
                  active={myBills}
                  onClick={() => onMyBillsChange(!myBills)}
                />
              </div>

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

              <div style={{ marginBottom: 20 }}>
                <SectionLabel title="Filters" />
                {statusOptions.length > 0 && (
                  <DimensionRow label="Status" selectedCount={statuses.length} onClick={() => setDimension('status')} buttonRef={rowRef('status')} />
                )}
                {priorityOptions.length > 0 && (
                  <DimensionRow label="Priority" selectedCount={priorities.length} onClick={() => setDimension('priority')} buttonRef={rowRef('priority')} />
                )}
                {positionOptions.length > 0 && (
                  <DimensionRow label="Position" selectedCount={positions.length} onClick={() => setDimension('position')} buttonRef={rowRef('position')} />
                )}
                {sessionVisible && (
                  <DimensionRow label="Session" selectedCount={sessions.length} onClick={() => setDimension('session')} buttonRef={rowRef('session')} />
                )}
                {tagOptions.length > 0 && (
                  <DimensionRow label="Topics" selectedCount={tags.length} onClick={() => setDimension('tags')} buttonRef={rowRef('tags')} />
                )}
                {subjectGroups.length > 0 && (
                  <DimensionRow label="Subject" selectedCount={subjects.length} onClick={() => setDimension('subjects')} buttonRef={rowRef('subjects')} />
                )}
              </div>
            </>
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
              ariaLabel="Topics"
              searchPlaceholder="Search topics…"
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
              ariaLabel="Subject"
              searchPlaceholder="Search subjects…"
              groups={subjectGroups.map(group => ({ key: group.state, heading: group.state, options: group.options }))}
              selected={subjects}
              onToggle={(value) => toggleItem(subjects, value, onSubjectChange)}
            />
          )}
        </div>
      </div>
    </>
  )
}
