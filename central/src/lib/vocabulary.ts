import type { Provider, StatusStage } from '../providers'

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
      .map(([typeId, t]) => ({ typeId: Number(typeId), label: t.label, explainer: t.explainer ?? null })),
    calendarName: v.calendarName ?? null,
  }
}
