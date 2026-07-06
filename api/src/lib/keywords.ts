export const ELECTION_KEYWORDS = [
  'election',
  'ballot',
  'voter',
  'voting',
  'precinct',
  'polling',
  'absentee',
  'poll worker',
  'election official',
  'canvass',
  'recount',
  'redistrict',
  'campaign finance',
  'candidate filing',
  'electoral college',
  'popular vote',
  'elective public office',
  'elective office',
  'nominating petition',
  'recall election',
]

// Mirror of central/src/lib/keywords.ts matchesUnion — must stay in sync.
const WORD_BOUNDARY_KEYWORDS = new Set(['election'])

export function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  for (const kw of keywords) {
    if (WORD_BOUNDARY_KEYWORDS.has(kw)) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![a-zA-Z])${escaped}`, 'i').test(lower)) return true
    } else {
      if (lower.includes(kw.toLowerCase())) return true
    }
  }
  return false
}
