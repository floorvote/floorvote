import { STATUS_STAGES, type StatusStage } from '../../../shared/statusStages'
import { decodeStatus } from './legislativeStatus'

/** What the facets response says of a status label with bills: the stage its bills sit in (or null) and the rank they sort by. */
export type StatusGroupInfo = { stage: string | null; rank: number }

/**
 * One heading of the grouped Status control: a stage with the statuses listed under it, or "Other" (`stage` null) for
 * the statuses with no stage. `count` is the stage's own count beside its heading, null for Other, which no stage names.
 */
export type StatusStageGroup = {
  stage: StatusStage | null
  label: string
  count: number | null
  options: { value: string; label: string }[]
}

/** The label of the heading for statuses that have no stage (or a stage this page does not know). */
export const OTHER_STAGE_LABEL = 'Other'

/**
 * The options of the Status control grouped by stage (#677): counts and `statusGroups` in, headings out.
 *
 * Headings are the stages, most advanced first, then Other last. Under a heading its statuses come most advanced
 * first by rank, then by label. Only the labels given are listed (the page passes those with bills and those seen
 * earlier in the session), and a heading with no listed statuses is left out. A label the facets did not name, and a
 * stage this page does not know, go under Other. The order of the stages is `STATUS_STAGES`, the fixed list.
 */
export function groupStatusOptions(input: {
  labels: readonly string[]
  counts: { stage: Record<string, number> }
  statusGroups: Record<string, StatusGroupInfo>
}): StatusStageGroup[] {
  const known = new Set<string>(STATUS_STAGES.map(s => s.key))
  const byStage = new Map<string | null, { value: string; label: string; rank: number }[]>()
  for (const value of new Set(input.labels)) {
    const info = input.statusGroups[value]
    const stage = info?.stage && known.has(info.stage) ? info.stage : null
    const row = { value, label: decodeStatus(value) ?? value, rank: info?.rank ?? 0 }
    byStage.set(stage, [...(byStage.get(stage) ?? []), row])
  }
  const order = <T extends { label: string; rank: number }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label))
  const group = (stage: StatusStage | null, label: string, count: number | null): StatusStageGroup[] => {
    const rows = byStage.get(stage)
    return rows ? [{ stage, label, count, options: order(rows).map(({ value, label }) => ({ value, label })) }] : []
  }
  return [
    ...[...STATUS_STAGES].reverse().flatMap(s => group(s.key, s.label, input.counts.stage[s.key] ?? 0)),
    ...group(null, OTHER_STAGE_LABEL, null),
  ]
}

/** How a stage heading's checkbox reads: on, off, or mixed (some of its statuses chosen). */
export type StageCheck = 'on' | 'off' | 'mixed'

/**
 * A stage heading's checkbox. On when its stage is chosen or every status under it is; mixed when only some of its
 * statuses are; off otherwise. A group with no stage (Other) has no heading checkbox, so it is always off.
 */
export function stageCheckState(group: StatusStageGroup, status: readonly string[], stage: readonly string[]): StageCheck {
  if (group.stage === null) return 'off'
  if (stage.includes(group.stage)) return 'on'
  const chosen = group.options.filter(o => status.includes(o.value)).length
  if (chosen === 0) return 'off'
  return chosen === group.options.length ? 'on' : 'mixed'
}

/**
 * What toggling a stage heading leaves chosen. A heading that reads on clears its stage and every status under it
 * (so a stage chosen status by status clears too). One that reads off or mixed chooses the whole stage, as the
 * heading always has (it writes `stage=<key>`), and leaves the statuses already chosen where they are.
 */
export function toggleStageSelection(group: StatusStageGroup, status: readonly string[], stage: readonly string[]): { status: string[]; stage: string[] } {
  if (group.stage === null) return { status: [...status], stage: [...stage] }
  if (stageCheckState(group, status, stage) === 'on') {
    const under = new Set(group.options.map(o => o.value))
    return { status: status.filter(v => !under.has(v)), stage: stage.filter(s => s !== group.stage) }
  }
  return { status: [...status], stage: [...stage, group.stage] }
}
