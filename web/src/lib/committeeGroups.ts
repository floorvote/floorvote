import { chamberLabel } from '../components/LegislativeHistory'

/** One committee in the Committee filter: central's id, its name with its chamber, and its count. */
export type CommitteeOption = { value: string; label: string; count: number }
/** A state's committees. Grouped by state, since every legislature has its own (two states' Judiciary are two committees). */
export type CommitteeGroup = { state: string; options: CommitteeOption[] }
/** The facets' `committeeInfo`: each committee counted or picked, by id. */
export type CommitteeInfo = Record<string, { name: string; state: string; chamber: string | null }>

/**
 * The Committee filter's options (#471), from the facets' counts and names: grouped by state, each state's committees
 * by count and then by name. A chamber is part of the label, as each chamber of a state has its own Judiciary. A
 * committee picked that the counts leave out (the scope or another filter left it no bills) is kept at zero, so it can
 * be unpicked, and the facets name every picked committee. A count the facets name no committee for is left out.
 */
export function committeeGroups(counts: Record<string, number>, info: CommitteeInfo, picked: readonly string[] = []): CommitteeGroup[] {
  const byState = new Map<string, CommitteeOption[]>()
  const all = { ...Object.fromEntries(picked.map(id => [id, 0])), ...counts }
  for (const [value, count] of Object.entries(all)) {
    const committee = info[value]
    if (!committee) continue
    const chamber = chamberLabel(committee.chamber ?? undefined)
    const option = {
      value,
      label: chamber ? `${committee.name} (${chamber})` : committee.name,
      count,
    }
    byState.set(committee.state, [...(byState.get(committee.state) ?? []), option])
  }
  return [...byState.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, options]) => ({
      state,
      options: options.sort((x, y) => y.count - x.count || x.label.localeCompare(y.label)),
    }))
}

/** Each committee's label by id, as the chips and the split pane's summary name them. */
export function committeeLabelsOf(groups: readonly CommitteeGroup[]): Record<string, string> {
  return Object.fromEntries(groups.flatMap(g => g.options.map(o => [o.value, o.label])))
}
