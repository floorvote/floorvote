/**
 * The common stages every provider's statuses map into, so bills from
 * different legislatures can be compared, filtered, and sorted together.
 * Central sends each bill's stage with its status label (each provider's
 * vocabulary file says which stage a status belongs to), and the bill list
 * filters on it.
 *
 * The order is the sort order. A status's rank is its stage's position here
 * (1-based) times 100, plus the provider's own order within the stage, so
 * every Enacted status sorts above every Passed one. Failed and Vetoed sit
 * between Passed and Enacted because that is where LegiScan's status sort has
 * always put them, and ranks must keep existing bill lists in the same order.
 * A bill with no stage has rank 0 and sorts below all of these.
 */
export const STATUS_STAGES = [
  { key: 'introduced', label: 'Introduced' },
  { key: 'in_committee', label: 'In committee' },
  { key: 'passed_one_chamber', label: 'Passed one chamber' },
  { key: 'passed', label: 'Passed legislature' },
  { key: 'failed', label: 'Failed' },
  { key: 'vetoed', label: 'Vetoed' },
  { key: 'enacted', label: 'Enacted' },
] as const

export type StatusStage = typeof STATUS_STAGES[number]['key']

/** A stage's position in the sort order, from 1. A status's rank is this times 100 plus its order within the stage. */
export function stagePosition(stage: StatusStage): number {
  return STATUS_STAGES.findIndex(s => s.key === stage) + 1
}

/** The member-facing name of a stage, or null for a value that names none. */
export function stageLabel(stage: string | null | undefined): string | null {
  return STATUS_STAGES.find(s => s.key === stage)?.label ?? null
}
