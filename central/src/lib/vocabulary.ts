import type { Provider, StatusStage } from '../providers'
import type { RelationshipKind } from '../../../shared/relationshipKinds'

/**
 * Reading a provider's vocabulary (`Provider.vocabulary`): what core sends for
 * a status code, which codes are terminal, and the explainers `/bills/labels`
 * serves.
 */

/** What the bill API sends for a status: its label, stage, and rank. */
export interface StatusFields {
  status: string
  statusStage: StatusStage | null
  statusRank: number
}

/**
 * A status code's label, stage, and rank. A code the vocabulary doesn't list
 * goes out as its number, with no stage and rank 0, so it sorts below every
 * known status.
 */
export function statusFields(provider: Provider, code: number): StatusFields {
  const s = provider.vocabulary.statuses[code]
  return s
    ? { status: s.label, statusStage: s.stage, statusRank: s.rank }
    : { status: String(code), statusStage: null, statusRank: 0 }
}

/** A status code as the change log names it. */
export function statusChangeLabel(provider: Provider, code: number): string {
  const s = provider.vocabulary.statuses[code]
  return s?.changeLabel ?? s?.label ?? String(code)
}

/** The provider's terminal status codes: measures in them are done changing. */
export function terminalStatuses(provider: Provider): number[] {
  return Object.entries(provider.vocabulary.statuses).filter(([, s]) => s.terminal).map(([code]) => Number(code))
}

/**
 * What `/bills/labels` serves for a state's provider: explainers for its
 * statuses (by rank), bill types, and event types, and its display details.
 * Codes and terminal flags stay in central. Instances store a bill's status
 * label, so they look statuses up by label.
 */
export function vocabularyLabels(provider: Provider) {
  const v = provider.vocabulary
  return {
    statuses: Object.values(v.statuses)
      .sort((a, b) => a.rank - b.rank)
      .map(s => ({ label: s.label, stage: s.stage, rank: s.rank, explainer: s.explainer })),
    billTypes: Object.entries(v.billTypes)
      .map(([value, t]) => ({ value, label: t.label, explainer: t.explainer ?? null })),
    eventTypes: Object.entries(v.eventTypes)
      .map(([typeId, t]) => ({ typeId: Number(typeId), label: t.label, kind: t.kind, explainer: t.explainer ?? null })),
    calendarName: v.calendarName ?? null,
  }
}

/**
 * The kind of one relationship, from the label the provider published (the
 * `type` of a `sasts` entry). A state's override wins over the provider's
 * default, and a label the vocabulary doesn't list is `related`. Never read
 * the numeric type id: ids collide across providers.
 */
export function relationshipKind(provider: Provider, state: string, label: string): RelationshipKind {
  const r = provider.vocabulary.relationships
  const key = labelKey(label)
  return lookupKind(r?.states?.[state], key) ?? lookupKind(r?.default, key) ?? 'related'
}

// A label with case, spacing, and hyphens ignored, since LegiScan spells one
// cross-file "Crossfiled" and the Maryland General Assembly spells it "Cross-filed".
function labelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function lookupKind(map: Readonly<Record<string, RelationshipKind>> | undefined, key: string): RelationshipKind | undefined {
  if (!map) return undefined
  for (const [label, kind] of Object.entries(map)) if (labelKey(label) === key) return kind
  return undefined
}

// Stubs for the red tests. Replaced in the next commit.
export function titleCompanionConflicts(_provider: Provider): string[] {
  return []
}

export function titleCompanionsOn(_provider: Provider, _state: string): boolean {
  return false
}

export function titleCompanionKey(_provider: Provider, _bill: { state: string; billType: string | null; body: string | null; title: string }): string | null {
  return null
}
