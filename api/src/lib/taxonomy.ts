export type TaxonomyItem = { name: string; description?: string }

export function parseTaxonomyItems(raw: unknown): TaxonomyItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    if (typeof item === 'string' && item) return [{ name: item }]
    if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') {
      const { name, description } = item as { name: string; description?: string }
      return description ? [{ name, description }] : [{ name }]
    }
    return []
  })
}

export const DEFAULT_TAXONOMY: TaxonomyItem[] = [
  { name: 'Health & Healthcare' },
  { name: 'Education' },
  { name: 'Elections & Voting' },
  { name: 'Housing & Land Use' },
  { name: 'Transportation & Infrastructure' },
  { name: 'Environment & Natural Resources' },
  { name: 'Criminal Justice & Public Safety' },
  { name: 'Taxation & Revenue' },
  { name: 'Labor & Employment' },
  { name: 'Business & Economic Development' },
  { name: 'Social Services & Human Services' },
  { name: 'Courts & Civil Procedure' },
  { name: 'State Government & Administration' },
  { name: 'Local Government' },
  { name: 'Agriculture & Rural Affairs' },
]

export const ELECTION_TAXONOMY: TaxonomyItem[] = [
  { name: 'Voter Registration' },
  { name: 'Voter ID Requirements' },
  { name: 'Mail & Absentee Voting' },
  { name: 'Early Voting' },
  { name: 'Election Day Operations' },
  { name: 'Poll Workers' },
  { name: 'Voting Equipment & Technology' },
  { name: 'Election Security' },
  { name: 'Redistricting & Reapportionment' },
  { name: 'Campaign Finance' },
  { name: 'Ballot Access & Candidate Filing' },
  { name: 'Overseas & Military Voting' },
  { name: 'Provisional Ballots' },
  { name: 'Election Audits & Recounts' },
  { name: 'Election Funding & Resources' },
  { name: 'Ranked Choice Voting' },
  { name: 'Voting Rights & Access' },
  { name: 'Primary Elections' },
  { name: 'Election Officials & Administration' },
]
