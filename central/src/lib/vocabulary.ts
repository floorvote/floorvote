import type { Provider, StatusStage } from '../providers'

/**
 * Reading a provider's vocabulary (`Provider.vocabulary`): what core sends for
 * a status code, and which codes are terminal.
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
