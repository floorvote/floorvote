import { isProceduralCommittee } from '../../../shared/committees'
import { chamberLabel } from '../components/LegislativeHistory'

/** One committee in the Committee filter: central's id, its name with its chamber, its count, and whether it is procedural. */
export type CommitteeOption = { value: string; label: string; count: number; procedural: boolean }
/** A state's committees. Grouped by state, since every legislature has its own (two states' Judiciary are two committees). */
export type CommitteeGroup = { state: string; options: CommitteeOption[] }
/** The facets' `committeeInfo`: each committee counted, by id. */
export type CommitteeInfo = Record<string, { name: string; state: string; chamber: string | null }>

/**
 * Every committee's label the facets have named this session, by id, so a chip or the split pane's summary can name
 * a committee the current facets leave out. It only grows, like the bill list's known states.
 */
export const knownCommitteeLabels = new Map<string, string>()

/**
 * The Committee filter's options (#471), from the facets' counts and names: grouped by state, each state's committees
 * by count and then by name, with the procedural ones (Rules, Assignments, Calendars) last and marked, since one can
 * hold half a session's bills. A chamber is part of the label, as each chamber of a state has its own Judiciary. A
 * count the facets name no committee for is left out.
 */
export function committeeGroups(counts: Record<string, number>, info: CommitteeInfo): CommitteeGroup[] {
  const byState = new Map<string, CommitteeOption[]>()
  for (const [value, count] of Object.entries(counts)) {
    const committee = info[value]
    if (!committee) continue
    const chamber = chamberLabel(committee.chamber ?? undefined)
    const option = {
      value,
      label: chamber ? `${committee.name} (${chamber})` : committee.name,
      count,
      procedural: isProceduralCommittee(committee.name),
    }
    knownCommitteeLabels.set(value, option.label)
    byState.set(committee.state, [...(byState.get(committee.state) ?? []), option])
  }
  return [...byState.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, options]) => ({
      state,
      options: options.sort((x, y) => Number(x.procedural) - Number(y.procedural) || y.count - x.count || x.label.localeCompare(y.label)),
    }))
}
