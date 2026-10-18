import type { StatusStage } from '../../../shared/statusStages'

export type StatusGroupInfo = { stage: string | null; rank: number }
export type StatusStageGroup = { stage: StatusStage | null; label: string; count: number | null; options: { value: string; label: string }[] }

export function groupStatusOptions(_input: {
  labels: readonly string[]
  counts: { stage: Record<string, number> }
  statusGroups: Record<string, StatusGroupInfo>
}): StatusStageGroup[] {
  return []
}
