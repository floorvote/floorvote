import { DEFAULT_AI_CONTEXT, DEFAULT_RELEVANCE_QUESTION } from './llm'
import { ELECTION_TAXONOMY, DEFAULT_TAXONOMY, type TaxonomyItem } from './taxonomy'
import { ELECTION_KEYWORDS } from './keywords'

interface Preset {
  slug: string
  name: string
  description: string
  aiContext: string
  relevanceQuestion: string
  taxonomy: TaxonomyItem[]
  keywords: string[]
}

export const PRESETS: Record<string, Preset> = {
  generic: {
    slug: 'generic',
    name: 'Generic (Policy Organization)',
    description: 'Broad policy area taxonomy and neutral framing. Good starting point for any legislative tracking use case.',
    aiContext: DEFAULT_AI_CONTEXT,
    relevanceQuestion: DEFAULT_RELEVANCE_QUESTION,
    taxonomy: DEFAULT_TAXONOMY,
    keywords: [],
  },
  election_officials: {
    slug: 'election_officials',
    name: 'Election Officials',
    description: 'Tuned for state associations of local election officials. Includes election-specific keywords, taxonomy, and relevance framing.',
    aiContext: `You are analyzing a bill for a state association of local election officials.

When writing the summary, start directly with an action verb or gerund phrase — do not begin with "This bill", "The bill", or the bill number (e.g. "Requires all counties to...", "Establishes a new procedure for...", "Prohibits local governments from..."). Be concise and proportional to the bill's complexity — a simple or narrow amendment warrants 1–2 sentences; a multi-part or substantive bill may warrant a short paragraph.`,
    relevanceQuestion: "Rate the bill's relevance to local election administration.",
    taxonomy: ELECTION_TAXONOMY,
    keywords: ELECTION_KEYWORDS,
  },
}
