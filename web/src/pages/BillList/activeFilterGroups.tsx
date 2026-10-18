import type { ReactNode } from 'react'
import { decodeStatus } from '../../lib/legislativeStatus'
import { stageLabel } from '../../../../shared/statusStages'
import { PRIORITY_COLORS, POSITION_COLORS, POSITION_FALLBACK } from '../../lib/chipStyles'
import { fontSize, radius } from '../../styles/tokens'
import { ActiveChip, FILTER_ANY } from './FilterPanel'
import type { CustomFieldDef } from './types'

export type ActiveFilterGroup = { key: string; chips: ReactNode[] }

export type ActiveFilterGroupArgs = {
  filterStates: string[]
  filterStatuses: string[]
  filterStages: string[]
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
  onRemoveStage: (s: string) => void
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

// The words on a chip, one function per dimension that needs more than the raw
// value. buildActiveFilterGroups draws them as chips; the split pane's summary
// (listSummary.ts) lists them in its hover text. Both go through here so the
// two can never word the same filter differently.
export type ChipFieldDef = { id: string; slug: string | null; name?: string; type?: string }

export function positionChipLabel(p: string, positionOptions: { value: string; label?: string }[]): string {
  return p === FILTER_ANY ? 'Any position' : (positionOptions.find(o => o.value === p)?.label ?? p)
}

/** A priority chip's label: the sentinels' words, else the tier's own label. */
export function priorityChipLabel(p: string): string {
  if (p === FILTER_ANY) return 'Any priority'
  if (p === 'none') return 'No priority'
  return (PRIORITY_COLORS[p] ?? PRIORITY_COLORS['medium']).label ?? p
}

export function subjectChipLabel(subject: string, isMultiState: boolean): string {
  const idx = subject.indexOf(':')
  return idx > 0
    ? (isMultiState ? `${subject.slice(0, idx)}: ${subject.slice(idx + 1)}` : subject.slice(idx + 1))
    : subject
}

// fieldId here is normally the def's real id, but it can still be the raw slug
// for a render or two after mount (useBillFilters resolves it against
// customFieldDefs once those load, but that's async) — match by either so the
// chip never falls back to printing the raw key.
export function customFieldChipLabel(fieldId: string, v: string, defs: ReadonlyArray<ChipFieldDef>): string {
  const field = defs.find(fld => fld.id === fieldId || fld.slug === fieldId)
  return field?.type === 'binary' ? (field?.name ?? fieldId) : `${field?.name ?? fieldId}: ${v === FILTER_ANY ? 'Any' : v}`
}

export type ActiveFilterLabelArgs = Pick<ActiveFilterGroupArgs,
  'filterStates' | 'filterStatuses' | 'filterStages' | 'filterPositions' | 'filterPriorities' | 'filterYears' |
  'selectedTags' | 'selectedSubjects' | 'cfFilters' | 'filterMinRelevance' | 'positionOptions' | 'isMultiState'
> & { customFieldDefs: ReadonlyArray<ChipFieldDef> }

// Every chip's label, one group per active dimension, in the order the chips
// are drawn. The same groups as buildActiveFilterGroups, minus the controls.
export function activeFilterLabelGroups(a: ActiveFilterLabelArgs): { key: string; labels: string[] }[] {
  const groups: { key: string; labels: string[] }[] = []
  const push = (key: string, labels: string[]) => { if (labels.length > 0) groups.push({ key, labels }) }
  push('state', a.filterStates)
  push('status', a.filterStatuses.map(s => decodeStatus(s) ?? s))
  push('stage', a.filterStages.map(s => stageLabel(s) ?? s))
  push('position', a.filterPositions.map(p => positionChipLabel(p, a.positionOptions)))
  push('priority', a.filterPriorities.map(priorityChipLabel))
  push('year', a.filterYears.map(y => `Year: ${y}`))
  if (a.filterMinRelevance > 0) push('minRelevance', [relevanceChipLabel(a.filterMinRelevance)])
  push('tags', a.selectedTags.map(tag => tag === FILTER_ANY ? 'Any tag' : tag))
  push('subjects', a.selectedSubjects.map(subject => subjectChipLabel(subject, a.isMultiState)))
  for (const [fieldId, values] of Object.entries(a.cfFilters)) {
    push(`cf_${fieldId}`, values.map(v => customFieldChipLabel(fieldId, v, a.customFieldDefs)))
  }
  return groups
}

// One group per active dimension, in filterDimensions registry order. Groups
// are what the AND/OR operator sits between, so a dimension with three
// selected values is ONE group of three chips, not three groups.
// Workflow-scope dimensions are absent by construction: they render in the
// scope cluster beside search and always narrow.
export function buildActiveFilterGroups(a: ActiveFilterGroupArgs): ActiveFilterGroup[] {
  const groups: ActiveFilterGroup[] = []
  const push = (key: string, chips: ReactNode[]) => { if (chips.length > 0) groups.push({ key, chips }) }

  push('state', a.filterStates.map(s => (
    <ActiveChip key={`state-${s}`} label={s} color="gray" onRemove={() => a.onRemoveState(s)} />
  )))
  push('status', a.filterStatuses.map(s => (
    <ActiveChip key={`status-${s}`} label={decodeStatus(s) ?? s} color="gray" onRemove={() => a.onRemoveStatus(s)} />
  )))
  push('stage', a.filterStages.map(s => (
    <ActiveChip key={`stage-${s}`} label={stageLabel(s) ?? s} color="gray" onRemove={() => a.onRemoveStage(s)} />
  )))
  push('position', a.filterPositions.map(p => {
    const posLabel = positionChipLabel(p, a.positionOptions)
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
      return <ActiveChip key={`pri-${p}`} label={priorityChipLabel(p)} color="gray" onRemove={() => a.onRemovePriority(p)} />
    }
    const pc = PRIORITY_COLORS[p] ?? PRIORITY_COLORS['medium']
    return (
      <span key={`pri-${p}`} style={{
        fontSize: fontSize.sm, padding: '2px 4px 2px 8px', borderRadius: radius.sm,
        background: pc.fill, color: pc.text,
        display: 'inline-flex', alignItems: 'center', gap: 3,
      }}>
        {priorityChipLabel(p)}
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
    return (
      <ActiveChip
        key={`subject-${subject}`}
        label={subjectChipLabel(subject, a.isMultiState)}
        color="purple"
        onRemove={() => a.onRemoveSubject(subject)}
      />
    )
  }))
  for (const [fieldId, values] of Object.entries(a.cfFilters)) {
    push(`cf_${fieldId}`, values.map(v => {
      return (
        <ActiveChip
          key={`cf-${fieldId}-${v}`}
          label={customFieldChipLabel(fieldId, v, a.customFieldDefs)}
          color="blue"
          onRemove={() => a.onRemoveCf(fieldId, v)}
        />
      )
    }))
  }
  return groups
}
