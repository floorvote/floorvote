import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import { SECTION_LABEL } from '../lib/textStyles'
import { Picker } from './Picker'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'
import { promotableCount, bulkConfirmMessage } from './bulkConfirm'

type Priority = 'high' | 'medium' | 'low'

export type Selection =
  | { mode: 'none' }
  | { mode: 'ids'; ids: Set<string> }
  | { mode: 'filter' }

export type CustomFieldDef = {
  id: string
  name: string
  type: 'binary' | 'dropdown'
  options: string[] | null
  multiple?: boolean
}

type MultiStagedDelta = { additions: string[]; removals: string[] }

function parseStoredMulti(raw: string | undefined | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch { /* fall through */ }
  return [raw]
}

type FilterState = {
  status: string[]
  priority: string[]
  position: string[]
  year: string[]
  state: string[]
  tag: string[]
  q: string
  minRelevance: number
  myBills: boolean
  unvoted: boolean
  cf: Record<string, string[]>
}

// Builds the `filter` request body from the active filter state (shared by the
// bulk-edit apply and bulk-dismiss flows so the two stay byte-identical).
function buildFilterBody(f: FilterState): Record<string, unknown> {
  return {
    ...(f.status.length > 0 && { status: f.status }),
    ...(f.priority.length > 0 && { priority: f.priority }),
    ...(f.position.length > 0 && { position: f.position }),
    ...(f.year.length > 0 && { year: f.year }),
    ...(f.state.length > 0 && { state: f.state }),
    ...(f.tag.length > 0 && { tag: f.tag }),
    ...(f.q && { q: f.q }),
    ...(f.minRelevance > 0 && { minRelevance: String(f.minRelevance) }),
    ...(f.myBills && { myBills: '1' }),
    ...(f.unvoted && { unvoted: '1' }),
    ...(Object.keys(f.cf).length > 0 && { cf: f.cf }),
  }
}

// 'mixed' means selected bills have different values for this field
type FieldValue = string | null | 'mixed'

type InitialValues = {
  priority: FieldValue
  position: FieldValue
  customFields: Record<string, FieldValue>
}

// A staged value of undefined means "same as initial" (not changing)
type StagedValues = {
  priority: string | null | undefined
  position: string | null | undefined
  customFields: Map<string, string | null>
  // Multi-select: per-field set of options to add/remove across all selected bills
  multiCustomFields: Map<string, MultiStagedDelta>
}

interface BulkActionBarProps {
  selection: Selection
  total: number
  positionVocabulary: string[]
  customFieldDefs: CustomFieldDef[]
  currentFilters: FilterState
  selectedBills: Array<{
    id: string
    priority: string | null
    matchType?: string | null
    position: string | null
    customFieldValues?: Record<string, string>
    newMatchAt?: string | null
    triagedAt?: string | null
  }>
  onClearSelection: () => void
  onApplied: (
    updatedIds: string[] | 'filter',
    updates: {
      priority?: Priority | null
      position?: string | null
      customFields?: Array<
        | { fieldId: string; value: string | null }
        | { fieldId: string; additions: string[]; removals: string[] }
      >
      triagedAt?: string | null
    }
  ) => void
}

const MIXED = 'mixed'
const PRIORITY_DISPLAY: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' }

function fmtFieldVal(val: string | null | 'mixed', isPriority = false): string {
  if (val === null) return 'Not set'
  if (val === MIXED) return 'Multiple values'
  if (isPriority) return PRIORITY_DISPLAY[val] ?? val
  return val
}

function computeDistribution(values: (string | null)[]): Record<string, number> {
  const dist: Record<string, number> = {}
  for (const v of values) {
    const key = v ?? 'null'
    dist[key] = (dist[key] ?? 0) + 1
  }
  return dist
}

function sharedValue(dist: Record<string, number>, total: number): FieldValue {
  const keys = Object.keys(dist)
  if (keys.length === 0) return null
  if (keys.length === 1 && dist[keys[0]] === total) {
    return keys[0] === 'null' ? null : keys[0]
  }
  return MIXED
}

function computeInitialFromBills(
  bills: BulkActionBarProps['selectedBills'],
  customFieldDefs: CustomFieldDef[],
): InitialValues {
  const n = bills.length
  if (n === 0) return { priority: null, position: null, customFields: {} }

  const priority = sharedValue(computeDistribution(bills.map(b => b.priority)), n)
  const position = sharedValue(computeDistribution(bills.map(b => b.position)), n)

  const customFields: Record<string, FieldValue> = {}
  for (const def of customFieldDefs) {
    const dist = computeDistribution(bills.map(b => b.customFieldValues?.[def.id] ?? null))
    customFields[def.id] = sharedValue(dist, n)
  }

  return { priority, position, customFields }
}

function computeInitialFromDistribution(
  data: { priorities: Record<string, number>; positions: Record<string, number>; customFields: Record<string, Record<string, number>> },
  count: number,
  customFieldDefs: CustomFieldDef[],
): InitialValues {
  const priority = sharedValue(data.priorities, count)
  const position = sharedValue(data.positions, count)
  const customFields: Record<string, FieldValue> = {}
  for (const def of customFieldDefs) {
    customFields[def.id] = sharedValue(data.customFields[def.id] ?? {}, count)
  }
  return { priority, position, customFields }
}

const SIDEBAR_DEFAULT_WIDTH = 225

function useSidebarWidth() {
  const [w, setW] = useState(() => {
    try { return parseInt(localStorage.getItem('sidebarWidth') ?? String(SIDEBAR_DEFAULT_WIDTH)) || SIDEBAR_DEFAULT_WIDTH } catch { return SIDEBAR_DEFAULT_WIDTH }
  })
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === 'sidebarWidth' && e.newValue) setW(parseInt(e.newValue) || SIDEBAR_DEFAULT_WIDTH)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return w
}

export function BulkActionBar({
  selection, total, positionVocabulary, customFieldDefs, currentFilters,
  selectedBills, onClearSelection, onApplied,
}: BulkActionBarProps) {
  const sidebarWidth = useSidebarWidth()
  const [initialValues, setInitialValues] = useState<InitialValues | null>(null)
  const [staged, setStaged] = useState<StagedValues>({
    priority: undefined, position: undefined, customFields: new Map(), multiCustomFields: new Map(),
  })
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [nullMatchCount, setNullMatchCount] = useState<number | null>(null)
  const [apiNewMatchCount, setApiNewMatchCount] = useState<number | null>(null)
  const prevModeRef = useRef(selection.mode)

  const count = selection.mode === 'ids' ? selection.ids.size
    : selection.mode === 'filter' ? total : 0
  const overLimit = count > 1000

  // Spring in when bar appears
  useEffect(() => {
    if (selection.mode !== 'none') {
      const id = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(id)
    } else {
      setVisible(false)
    }
  }, [selection.mode !== 'none']) // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-populate from selectedBills (ids mode)
  useEffect(() => {
    if (selection.mode !== 'ids') return
    setInitialValues(computeInitialFromBills(selectedBills, customFieldDefs))
  }, [selection.mode, selectedBills, customFieldDefs])

  // Pre-populate from API (filter mode, count ≤ 1000)
  useEffect(() => {
    if (selection.mode !== 'filter') return
    if (total > 1000) { setInitialValues(null); setNullMatchCount(null); setApiNewMatchCount(null); return }

    const params = new URLSearchParams()
    currentFilters.status.forEach(s => params.append('status', s))
    currentFilters.priority.forEach(p => params.append('priority', p))
    currentFilters.position.forEach(p => params.append('position', p))
    currentFilters.year.forEach(y => params.append('year', y))
    currentFilters.state.forEach(s => params.append('state', s))
    currentFilters.tag.forEach(t => params.append('tag', t))
    if (currentFilters.q) params.set('q', currentFilters.q)
    if (currentFilters.minRelevance > 0) params.set('minRelevance', String(currentFilters.minRelevance))
    if (currentFilters.myBills) params.set('myBills', '1')
    if (currentFilters.unvoted) params.set('unvoted', '1')
    for (const [fieldId, values] of Object.entries(currentFilters.cf)) {
      values.forEach(v => params.append(`cf_${fieldId}`, v))
    }

    apiFetch<{ count: number; priorities: Record<string, number>; positions: Record<string, number>; customFields: Record<string, Record<string, number>>; nullMatchCount: number; newMatchCount: number }>(
      `/bills/bulk-values?${params}`
    ).then(data => {
      setInitialValues(computeInitialFromDistribution(data, data.count, customFieldDefs))
      setNullMatchCount(data.nullMatchCount)
      setApiNewMatchCount(data.newMatchCount)
    }).catch(() => { setInitialValues(null); setNullMatchCount(null); setApiNewMatchCount(null) })
  }, [selection.mode, total, currentFilters, customFieldDefs])

  // Reset staged values when selection changes mode
  useEffect(() => {
    if (prevModeRef.current !== selection.mode) {
      setStaged({ priority: undefined, position: undefined, customFields: new Map(), multiCustomFields: new Map() })
      setError(null)
    }
    prevModeRef.current = selection.mode
  }, [selection.mode])

  // Reset everything when selection is cleared
  useEffect(() => {
    if (selection.mode === 'none') {
      setStaged({ priority: undefined, position: undefined, customFields: new Map(), multiCustomFields: new Map() })
      setInitialValues(null)
      setError(null)
    }
  }, [selection.mode])

  // Warn on tab/window close if staged
  const hasMultiPending = [...staged.multiCustomFields.values()].some(d => d.additions.length > 0 || d.removals.length > 0)
  const hasPending = staged.priority !== undefined || staged.position !== undefined || staged.customFields.size > 0 || hasMultiPending
  useEffect(() => {
    if (!hasPending) return
    function handler(e: BeforeUnloadEvent) { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasPending])

  if (selection.mode === 'none') return null

  // Effective display value for a field: staged overrides initial
  function effVal(stagedV: string | null | undefined, initial: FieldValue | undefined): string | null | 'mixed' {
    if (stagedV !== undefined) return stagedV
    return initial ?? null
  }

  function setStagedField(
    field: 'priority' | 'position',
    newVal: string | null,
    initial: FieldValue | undefined,
  ) {
    const effectiveInitial = initial === MIXED ? MIXED : (initial ?? null)
    const isUndo = newVal === effectiveInitial || (newVal === null && effectiveInitial === null)
    setStaged(prev => ({ ...prev, [field]: isUndo ? undefined : newVal }))
  }

  function clearStaged(field: 'priority' | 'position') {
    setStaged(prev => ({ ...prev, [field]: undefined }))
  }

  function clearStagedCf(fieldId: string) {
    setStaged(prev => {
      const next = new Map(prev.customFields)
      next.delete(fieldId)
      return { ...prev, customFields: next }
    })
  }

  function setStagedCf(fieldId: string, newVal: string | null | undefined) {
    setStaged(prev => {
      const next = new Map(prev.customFields)
      if (newVal === undefined) {
        next.delete(fieldId)
      } else {
        const initial = initialValues?.customFields[fieldId]
        const effectiveInitial = initial === MIXED ? MIXED : (initial ?? null)
        const isUndo = newVal === effectiveInitial || (newVal === null && effectiveInitial === null)
        if (isUndo) next.delete(fieldId)
        else next.set(fieldId, newVal)
      }
      return { ...prev, customFields: next }
    })
  }

  async function handleApply() {
    if (!hasPending || applying || overLimit) return
    const lines = [
      staged.priority !== undefined
        ? `• Priority → ${fmtFieldVal(staged.priority, true)}`
        : null,
      staged.position !== undefined
        ? `• Position → ${fmtFieldVal(staged.position)}`
        : null,
      ...[...staged.customFields.entries()].map(([fieldId, v]) => {
        const def = customFieldDefs.find(f => f.id === fieldId)
        const valLabel = v === null ? 'Not set' : (def?.type === 'binary' ? 'Yes' : v)
        return `• ${def?.name ?? 'Custom field'} → ${valLabel}`
      }),
      ...[...staged.multiCustomFields.entries()]
        .filter(([, d]) => d.additions.length > 0 || d.removals.length > 0)
        .map(([fieldId, d]) => {
          const def = customFieldDefs.find(f => f.id === fieldId)
          const parts: string[] = []
          if (d.additions.length > 0) parts.push(`+ ${d.additions.join(', ')}`)
          if (d.removals.length > 0) parts.push(`− ${d.removals.join(', ')}`)
          return `• ${def?.name ?? 'Custom field'}: ${parts.join('  ')}`
        }),
    ].filter(Boolean).join('\n')

    const promoteCount = promotableCount({
      mode: selection.mode,
      selectedBills,
      nullMatchCount,
      stagedPriority: staged.priority,
    })
    const confirmed = window.confirm(bulkConfirmMessage({ count, lines, promotableCount: promoteCount }))
    if (!confirmed) return

    setApplying(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {}
      if (selection.mode === 'ids') {
        body.ids = [...selection.ids]
      } else {
        body.filter = buildFilterBody(currentFilters)
      }
      if (staged.priority !== undefined) body.priority = staged.priority
      if (staged.position !== undefined) body.position = staged.position
      const cfEntries: Array<
        | { fieldId: string; value: string | null }
        | { fieldId: string; additions: string[]; removals: string[] }
      > = [
        ...[...staged.customFields.entries()].map(([fieldId, value]) => ({ fieldId, value })),
        ...[...staged.multiCustomFields.entries()]
          .filter(([, d]) => d.additions.length > 0 || d.removals.length > 0)
          .map(([fieldId, d]) => ({ fieldId, additions: d.additions, removals: d.removals })),
      ]
      if (cfEntries.length > 0) body.customFields = cfEntries
      await apiFetch<{ updated: number }>('/bills/bulk', { method: 'POST', body: JSON.stringify(body) })

      const updates: Parameters<typeof onApplied>[1] = {}
      if (staged.priority !== undefined) updates.priority = staged.priority as Priority | null
      if (staged.position !== undefined) updates.position = staged.position
      if (cfEntries.length > 0) updates.customFields = cfEntries
      onApplied(selection.mode === 'ids' ? [...selection.ids] : 'filter', updates)
      setStaged({ priority: undefined, position: undefined, customFields: new Map(), multiCustomFields: new Map() })
      onClearSelection()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply changes')
    } finally {
      setApplying(false)
    }
  }

  const newMatchCount = selection.mode === 'filter'
    ? (apiNewMatchCount ?? 0)
    : selectedBills.filter(b => b.matchType === 'keyword' && b.newMatchAt && !b.triagedAt).length

  async function handleDismissNewMatches() {
    if (newMatchCount === 0 || applying || overLimit) return
    if (!window.confirm(`Dismiss ${newMatchCount.toLocaleString()} new match${newMatchCount !== 1 ? 'es' : ''} (mark reviewed, no priority)? They leave the New-matches queue but stay tracked.`)) return
    setApplying(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {}
      if (selection.mode === 'ids') {
        body.ids = [...selection.ids]
      } else {
        body.filter = buildFilterBody(currentFilters)
      }
      await apiFetch<{ dismissed: number }>('/bills/bulk-dismiss', { method: 'POST', body: JSON.stringify(body) })
      if (selection.mode === 'ids') {
        // Stamp only the dismissed subset so those rows leave the New-matches
        // queue locally (filter mode refetches, so no local stamp needed).
        const dismissedIds = selectedBills
          .filter(b => b.matchType === 'keyword' && b.newMatchAt && !b.triagedAt)
          .map(b => b.id)
        onApplied(dismissedIds, { triagedAt: new Date().toISOString() })
      } else {
        onApplied('filter', {})
      }
      onClearSelection()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss new matches')
    } finally {
      setApplying(false)
    }
  }

  const applyable = hasPending && !applying && !overLimit

  // Renders a filter-bar-style pill button with a dropdown for a single field
  function renderPill(params: {
    fieldKey: string
    label: string
    eff: string | null | 'mixed'
    isStaged: boolean
    options: Array<{ value: string | null; label: string }>
    onSelect: (val: string | null) => void
    onUndo: () => void
    isPriority?: boolean
  }) {
    const { fieldKey, label, eff, isStaged, options, onSelect, onUndo, isPriority } = params
    // Split the synthetic "Not set" (null) option out into Picker's emptyOption.
    const emptyOpt = options.find(o => o.value === null)
    const realOptions = options.filter((o): o is { value: string; label: string } => o.value !== null)

    return (
      <div key={fieldKey} data-bulk-pill="" style={{ flexShrink: 0 }}>
        <Picker
          mode="single"
          value={eff ?? null}
          options={realOptions}
          emptyOption={emptyOpt ? { label: emptyOpt.label } : undefined}
          onChange={(next) => onSelect(next)}
          placement="top"
          panelMinWidth={160}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              style={{
                fontSize: fontSize.sm, padding: '6px 10px', borderRadius: radius.md,
                display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
                cursor: 'pointer',
                background: isStaged ? color.bgInfo : color.white,
                color: isStaged ? color.partyDemBlue : color.textSlate,
                border: `1px solid ${isStaged ? color.tagBorderBlue : color.borderDefault}`,
                fontWeight: isStaged ? fontWeight.medium : fontWeight.normal,
              }}
            >
              {label}: {fmtFieldVal(eff, isPriority)}
              {isStaged && (
                <span
                  className="bulk-undo-btn"
                  role="button"
                  onClick={e => { e.stopPropagation(); onUndo() }}
                  title={`Undo ${label} change`}
                  style={{ fontSize: fontSize.sm, lineHeight: 1, cursor: 'pointer', opacity: 0.65 }}
                >↺</span>
              )}
              <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ flexShrink: 0 }}>
                <path
                  d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'}
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        />
      </div>
    )
  }

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: sidebarWidth, right: 0,
      display: 'flex', justifyContent: 'center', alignItems: 'flex-end',
      paddingBottom: 24, paddingLeft: 16, paddingRight: 16,
      zIndex: 200, pointerEvents: 'none',
    }}>
      <div style={{
        pointerEvents: 'auto',
        background: color.white,
        borderRadius: radius.xl,
        boxShadow: shadow.lg,
        border: `1px solid ${color.borderDefault}`,
        display: 'flex',
        width: '100%',
        maxWidth: 960,
        transformOrigin: 'bottom center',
        transform: visible ? 'scale(1) translateY(0)' : 'scale(0.92) translateY(10px)',
        opacity: visible ? 1 : 0,
        transition: 'transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.14s ease',
      }}>

        <style>{`.bulk-undo-btn { padding: 0 3px; border-radius: 3px; } .bulk-undo-btn:hover { opacity: 1 !important; background: #e0f2fe; }`}</style>

        {/* Left column: label / count / apply */}
        <div style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
          padding: '10px 14px', gap: 6, flexShrink: 0, minWidth: 148,
          borderRight: `1px solid ${color.borderDefault}`,
        }}>
          <span style={SECTION_LABEL}>
            Bulk edit
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary }}>
              {count.toLocaleString()} bill{count !== 1 ? 's' : ''} selected
            </span>
            <button
              onClick={onClearSelection}
              style={{ fontSize: fontSize.sm, padding: '3px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, background: color.white, color: color.textSecondary, cursor: 'pointer' }}
            >
              Deselect all
            </button>
          </div>

          <button
            onClick={handleApply}
            disabled={!applyable}
            style={{
              fontSize: fontSize.sm, fontWeight: fontWeight.bold, padding: '5px 10px',
              borderRadius: radius.md, border: 'none', textAlign: 'left',
              cursor: applyable ? 'pointer' : 'not-allowed',
              background: applyable ? color.linkBlue : color.borderDefault,
              color: applyable ? color.white : color.textMuted,
              opacity: applying ? 0.7 : 1,
              transition: 'background 0.15s, color 0.15s',
              lineHeight: 1.35,
            }}
          >
            {applying ? 'Applying…'
              : overLimit ? `Too many — narrow to ≤1,000`
              : `Apply to ${count.toLocaleString()} bill${count !== 1 ? 's' : ''}`}
          </button>

          {error && <span style={{ fontSize: fontSize.xs, color: color.textErrorRed, lineHeight: 1.3 }}>{error}</span>}
        </div>

        {/* Right column: field pills */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '10px 14px', flex: 1, alignContent: 'center',
        }}>

        {/* Position pill */}
        {renderPill({
          fieldKey: 'position',
          label: 'Position',
          eff: effVal(staged.position, initialValues?.position),
          isStaged: staged.position !== undefined,
          options: [
            { value: null, label: 'Not set' },
            ...positionVocabulary.map(p => ({ value: p, label: p })),
          ],
          onSelect: val => setStagedField('position', val, initialValues?.position),
          onUndo: () => clearStaged('position'),
        })}

        {/* Priority pill + dismiss-new-matches, stacked (mirrors the single-row triage control) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
          {renderPill({
            fieldKey: 'priority',
            label: 'Priority',
            eff: effVal(staged.priority, initialValues?.priority),
            isStaged: staged.priority !== undefined,
            isPriority: true,
            options: [
              { value: null, label: 'Not set' },
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' },
            ],
            onSelect: val => setStagedField('priority', val, initialValues?.priority),
            onUndo: () => clearStaged('priority'),
          })}
          {newMatchCount > 0 && (
            <button
              type="button"
              onClick={handleDismissNewMatches}
              disabled={applying}
              title="Mark the new matches in this selection as reviewed — no priority"
              style={{
                fontSize: fontSize.sm, padding: '4px 10px', borderRadius: radius.md,
                border: `1px solid ${color.borderDefault}`, background: color.white,
                color: color.textMuted, cursor: applying ? 'not-allowed' : 'pointer',
                textAlign: 'left', whiteSpace: 'nowrap',
              }}
            >
              ✕ Dismiss new matches ({newMatchCount.toLocaleString()})
            </button>
          )}
        </div>

        {/* Custom field pills */}
        {customFieldDefs.map(field => {
          // Multi-select dropdown (ids mode only — filter mode would need per-option distribution from the API).
          if (field.type === 'dropdown' && field.multiple) {
            if (selection.mode !== 'ids') {
              return (
                <button
                  key={field.id}
                  disabled
                  title="Select bills directly to bulk-edit multi-select fields"
                  style={{
                    fontSize: fontSize.sm, padding: '6px 10px', borderRadius: radius.md,
                    background: color.surfaceSubtle, color: color.textMuted, border: `1px solid ${color.borderDefault}`,
                    cursor: 'not-allowed', flexShrink: 0,
                  }}
                >
                  {field.name}
                </button>
              )
            }

            const options = field.options ?? []
            const allHave = new Set<string>()
            const indeterminate = new Set<string>()
            const n = selectedBills.length
            for (const opt of options) {
              let count = 0
              for (const b of selectedBills) {
                const arr = parseStoredMulti(b.customFieldValues?.[field.id])
                if (arr.includes(opt)) count++
              }
              if (count === n && n > 0) allHave.add(opt)
              else if (count > 0) indeterminate.add(opt)
            }

            const delta = staged.multiCustomFields.get(field.id) ?? { additions: [], removals: [] }
            const additionsSet = new Set(delta.additions)
            const removalsSet = new Set(delta.removals)

            // Effective state per option: allHave\removals ∪ additions; indeterminate minus staged
            const effectiveChecked: string[] = []
            for (const o of allHave) if (!removalsSet.has(o)) effectiveChecked.push(o)
            for (const o of additionsSet) if (!effectiveChecked.includes(o)) effectiveChecked.push(o)
            const effectiveIndeterminate = new Set<string>()
            for (const o of indeterminate) {
              if (!additionsSet.has(o) && !removalsSet.has(o)) effectiveIndeterminate.add(o)
            }

            const isStaged = delta.additions.length > 0 || delta.removals.length > 0

            function onPickerChange(next: string[]) {
              // Determine which single option was just clicked, and to what side
              // (check or uncheck). The Picker calls onChange with one element
              // changed at a time, so the diff is exactly one option.
              const before = new Set(effectiveChecked)
              const after = new Set(next)
              let clicked: string | null = null
              let direction: 'check' | 'uncheck' | null = null
              for (const o of after) { if (!before.has(o)) { clicked = o; direction = 'check'; break } }
              if (!clicked) {
                for (const o of before) { if (!after.has(o)) { clicked = o; direction = 'uncheck'; break } }
              }
              if (!clicked || !direction) return

              setStaged(prev => {
                const additions = new Set(delta.additions)
                const removals = new Set(delta.removals)
                const opt = clicked!

                // Per-option transition rules:
                //   • allHave         (originally on every bill) → 2-state toggle: original ↔ force-off (removal)
                //   • indeterminate   (some have, some don't)    → binary toggle: force-on ↔ force-off (no revert to original)
                //   • neither (∅)     (no bill has it)           → 2-state toggle: original ↔ force-on (addition)
                if (allHave.has(opt)) {
                  if (direction === 'uncheck') {
                    removals.add(opt)
                    additions.delete(opt)
                  } else {
                    // re-checking → revert to original (allHave)
                    removals.delete(opt)
                    additions.delete(opt)
                  }
                } else if (indeterminate.has(opt)) {
                  if (direction === 'check') {
                    additions.add(opt)
                    removals.delete(opt)
                  } else {
                    additions.delete(opt)
                    removals.add(opt)
                  }
                } else {
                  if (direction === 'check') {
                    additions.add(opt)
                    removals.delete(opt)
                  } else {
                    // unchecking → revert (we're back to the original ∅)
                    additions.delete(opt)
                    removals.delete(opt)
                  }
                }

                const nextDelta: MultiStagedDelta = {
                  additions: [...additions],
                  removals: [...removals],
                }
                const nextMap = new Map(prev.multiCustomFields)
                if (nextDelta.additions.length === 0 && nextDelta.removals.length === 0) {
                  nextMap.delete(field.id)
                } else {
                  nextMap.set(field.id, nextDelta)
                }
                return { ...prev, multiCustomFields: nextMap }
              })
            }

            const triggerLabel = (() => {
              if (isStaged) return `${field.name}: Changed`
              if (indeterminate.size > 0) return `${field.name}: Multiple values`
              if (allHave.size > 0) return `${field.name}: ${[...allHave].join(', ')}`
              return `${field.name}: Not set`
            })()

            return (
              <div key={field.id} data-bulk-pill="" style={{ position: 'relative', flexShrink: 0 }}>
                <Picker
                  mode="multi"
                  value={effectiveChecked}
                  indeterminate={effectiveIndeterminate}
                  options={options.map(o => ({ value: o, label: o }))}
                  onChange={onPickerChange}
                  placement="top"
                  trigger={({ toggle, open }) => (
                    <button
                      onClick={toggle}
                      style={{
                        fontSize: fontSize.sm, padding: '6px 10px', borderRadius: radius.md,
                        display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
                        cursor: 'pointer',
                        background: isStaged ? color.bgInfo : color.white,
                        color: isStaged ? color.partyDemBlue : color.textSlate,
                        border: `1px solid ${isStaged ? color.tagBorderBlue : color.borderDefault}`,
                        fontWeight: isStaged ? fontWeight.medium : fontWeight.normal,
                        maxWidth: 260,
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{triggerLabel}</span>
                      {isStaged && (
                        <span
                          className="bulk-undo-btn"
                          role="button"
                          onClick={e => {
                            e.stopPropagation()
                            setStaged(prev => {
                              const m = new Map(prev.multiCustomFields)
                              m.delete(field.id)
                              return { ...prev, multiCustomFields: m }
                            })
                          }}
                          title={`Undo ${field.name} change`}
                          style={{ fontSize: fontSize.sm, lineHeight: 1, cursor: 'pointer', opacity: 0.65 }}
                        >↺</span>
                      )}
                      <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ flexShrink: 0 }}>
                        <path
                          d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'}
                          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                />
              </div>
            )
          }

          const initial = initialValues?.customFields[field.id]
          const stagedVal: string | null | undefined = staged.customFields.has(field.id)
            ? (staged.customFields.get(field.id) as string | null)
            : undefined
          const eff = effVal(stagedVal, initial)
          const isStaged = staged.customFields.has(field.id)

          if (field.type === 'binary') {
            const isChecked = eff === '1'
            const isMixed = eff === MIXED
            return (
              <label
                key={field.id}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: fontSize.sm, cursor: 'pointer', flexShrink: 0,
                  color: isStaged ? color.partyDemBlue : color.textSlate,
                  fontWeight: isStaged ? fontWeight.medium : fontWeight.normal,
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  ref={el => { if (el) el.indeterminate = isMixed }}
                  onChange={() => setStagedCf(field.id, isChecked ? null : '1')}
                  style={{ margin: 0, accentColor: color.accentBlue, cursor: 'pointer', width: 14, height: 14 }}
                />
                {field.name}
                {isStaged && (
                  <span
                    className="bulk-undo-btn"
                    role="button"
                    onClick={e => { e.preventDefault(); clearStagedCf(field.id) }}
                    title={`Undo ${field.name} change`}
                    style={{ fontSize: fontSize.sm, lineHeight: 1, cursor: 'pointer', opacity: 0.65 }}
                  >↺</span>
                )}
              </label>
            )
          }

          return renderPill({
            fieldKey: field.id,
            label: field.name,
            eff,
            isStaged,
            options: [{ value: null, label: 'Not set' }, ...(field.options ?? []).map(o => ({ value: o, label: o }))],
            onSelect: val => setStagedCf(field.id, val),
            onUndo: () => clearStagedCf(field.id),
          })
        })}
        </div>
      </div>
    </div>
  )
}
