import type { ReactNode } from 'react'
import { decodeStatus } from '../../lib/legislativeStatus'
import { PRIORITY_COLORS, POSITION_COLORS, POSITION_FALLBACK } from '../../lib/chipStyles'
import { fontSize, radius } from '../../styles/tokens'
import { ActiveChip, FILTER_ANY } from './FilterPanel'
import type { CustomFieldDef } from './types'

export type ActiveFilterGroup = { key: string; chips: ReactNode[] }

export type ActiveFilterGroupArgs = {
  filterStates: string[]
  filterStatuses: string[]
  filterPositions: string[]
  filterPriorities: string[]
  filterYears: number[]
  selectedTags: string[]
  selectedSubjects: string[]
  cfFilters: Record<string, string[]>
  filterMinRelevance: number
  positionOptions: { value: string; label?: string }[]
  customFieldDefs: CustomFieldDef[]
  /** Subject values are stored state-prefixed ("NJ:Elections") in every tenant.
   *  In a single-state tenant that prefix is the same on every chip, so it is
   *  dropped from the label only — the stored value, and therefore removal,
   *  is unaffected. */
  isMultiState: boolean
  onRemoveState: (s: string) => void
  onRemoveStatus: (s: string) => void
  onRemovePosition: (p: string) => void
  onRemovePriority: (p: string) => void
  onRemoveYear: (y: number) => void
  onRemoveTag: (tag: string) => void
  onRemoveSubject: (subject: string) => void
  onRemoveCf: (fieldId: string, value: string) => void
  onRemoveMinRelevance: () => void
}

// Mirrors the relevance slider's own label format (index.tsx:801): "N+" below
// the top of the range, a bare "10" at the top. At 0 the slider reads "All"
// and no chip renders at all. A threshold is not a value set, so this group
// always holds exactly one chip — which costs nothing, since it still joins
// the operator like any other group.
export function relevanceChipLabel(n: number): string {
  return n >= 10 ? 'Relevance 10' : `Relevance ${n}+`
}

// One group per active dimension, in filterDimensions registry order. Groups
// are what the AND/OR operator sits between, so a dimension with three
// selected values is ONE group of three chips, not three groups.
// Viewer-scope dimensions are absent by construction: they render in the scope
// cluster beside search and always narrow.
export function buildActiveFilterGroups(a: ActiveFilterGroupArgs): ActiveFilterGroup[] {
  const groups: ActiveFilterGroup[] = []
  const push = (key: string, chips: ReactNode[]) => { if (chips.length > 0) groups.push({ key, chips }) }

  push('state', a.filterStates.map(s => (
    <ActiveChip key={`state-${s}`} label={s} color="gray" onRemove={() => a.onRemoveState(s)} />
  )))
  push('status', a.filterStatuses.map(s => (
    <ActiveChip key={`status-${s}`} label={decodeStatus(s) ?? s} color="gray" onRemove={() => a.onRemoveStatus(s)} />
  )))
  push('position', a.filterPositions.map(p => {
    const posLabel = p === FILTER_ANY ? 'Any position' : ((a.positionOptions.find(o => o.value === p) as { value: string; label?: string } | undefined)?.label ?? p)
    const posColor = POSITION_COLORS[p] ?? POSITION_FALLBACK
    return (
      <span key={`pos-${p}`} style={{
        fontSize: fontSize.sm, padding: '2px 4px 2px 8px', borderRadius: radius.sm,
        background: posColor.bg, color: posColor.color, border: `1px solid ${posColor.border}`,
        display: 'inline-flex', alignItems: 'center', gap: 3,
      }}>
        {posLabel}
        <button
          onClick={() => a.onRemovePosition(p)}
          style={{ background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer', color: posColor.color, lineHeight: 1, fontSize: fontSize.base, display: 'flex', alignItems: 'center' }}
        >×</button>
      </span>
    )
  }))
  push('priority', a.filterPriorities.map(p => {
    if (p === FILTER_ANY || p === 'none') {
      return <ActiveChip key={`pri-${p}`} label={p === FILTER_ANY ? 'Any priority' : 'No priority'} color="gray" onRemove={() => a.onRemovePriority(p)} />
    }
    const pc = PRIORITY_COLORS[p] ?? PRIORITY_COLORS['medium']
    return (
      <span key={`pri-${p}`} style={{
        fontSize: fontSize.sm, padding: '2px 4px 2px 8px', borderRadius: radius.sm,
        background: pc.fill, color: pc.text,
        display: 'inline-flex', alignItems: 'center', gap: 3,
      }}>
        {pc.label ?? p}
        <button
          onClick={() => a.onRemovePriority(p)}
          style={{ background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer', color: pc.text, lineHeight: 1, fontSize: fontSize.base, display: 'flex', alignItems: 'center' }}
        >×</button>
      </span>
    )
  }))
  push('year', a.filterYears.map(y => (
    <ActiveChip key={`year-${y}`} label={`Year: ${y}`} color="gray" onRemove={() => a.onRemoveYear(y)} />
  )))
  if (a.filterMinRelevance > 0) {
    push('minRelevance', [
      <ActiveChip key="minRelevance" label={relevanceChipLabel(a.filterMinRelevance)} color="gray" onRemove={a.onRemoveMinRelevance} />,
    ])
  }
  push('tags', a.selectedTags.map(tag => (
    <ActiveChip key={`tag-${tag}`} label={tag === FILTER_ANY ? 'Any tag' : tag} color="blue" onRemove={() => a.onRemoveTag(tag)} />
  )))
  push('subjects', a.selectedSubjects.map(subject => {
    const idx = subject.indexOf(':')
    const label = idx > 0
      ? (a.isMultiState ? `${subject.slice(0, idx)}: ${subject.slice(idx + 1)}` : subject.slice(idx + 1))
      : subject
    return (
      <ActiveChip
        key={`subject-${subject}`}
        label={label}
        color="purple"
        onRemove={() => a.onRemoveSubject(subject)}
      />
    )
  }))
  for (const [fieldId, values] of Object.entries(a.cfFilters)) {
    push(`cf_${fieldId}`, values.map(v => {
      // fieldId here is normally the def's real id, but it can still be the raw
      // slug for a render or two after mount (useBillFilters resolves it against
      // customFieldDefs once those load, but that's async) — match by either so
      // the chip never falls back to printing the raw key.
      const field = a.customFieldDefs.find(fld => fld.id === fieldId || fld.slug === fieldId)
      return (
        <ActiveChip
          key={`cf-${fieldId}-${v}`}
          label={field?.type === 'binary' ? (field?.name ?? fieldId) : `${field?.name ?? fieldId}: ${v === FILTER_ANY ? 'Any' : v}`}
          color="blue"
          onRemove={() => a.onRemoveCf(fieldId, v)}
        />
      )
    }))
  }
  return groups
}
