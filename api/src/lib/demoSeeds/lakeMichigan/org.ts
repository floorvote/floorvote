import type { DemoSeedModule, DemoSeedSession } from '../types'
import type { TaxonomyItem } from '../../taxonomy'

/** Eight themes, each represented by at least two of the seed's 20 bills. */
const TAXONOMY: TaxonomyItem[] = [
  { name: 'Drinking Water', description: 'Tap water safety, testing, and treatment standards.' },
  { name: 'Lead Service Lines', description: 'Replacing lead pipes and funding the work.' },
  { name: 'PFAS & Contaminants', description: 'PFAS and other persistent chemical contamination.' },
  { name: 'Beaches & Shoreline', description: 'Beach water quality, closures, access, and erosion.' },
  { name: 'Septic & Wastewater', description: 'Septic systems, sewers, and wastewater treatment.' },
  { name: 'Invasive Species', description: 'Aquatic invasive species prevention and control.' },
  { name: 'Water Withdrawal', description: 'Withdrawals, diversions, and groundwater protection.' },
  { name: 'Great Lakes', description: 'Basin-wide restoration, funding, and shoreline programs.' },
]

/**
 * Every keyword here was validated against the 37,952-bill LegiScan corpus — the
 * manifest records each one's real match count. A keyword that matches nothing is
 * worse than useless, because these drive central's per-state ingest filter.
 * Rejected for matching nothing: 'nutrient runoff', 'combined sewer overflow'.
 */
const KEYWORDS = [
  'pfas', 'drinking water', 'great lakes', 'water quality', 'groundwater', 'wetland',
  'lead service line', 'erosion', 'stormwater', 'sewage', 'microplastic',
  'invasive species', 'water withdrawal', 'dredging', 'water utility', 'shoreline',
  'harmful algal bloom', 'water main', 'septic', 'aquatic invasive', 'watershed', 'beach',
]

const SESSIONS: DemoSeedSession[] = [
  { identifier: '2183', name: 'Michigan 103rd Legislature', classification: 'primary', startDate: '2025-01-01', endDate: '2026-12-31' },
  { identifier: '2197', name: 'Wisconsin 2025-2026 Regular Session', classification: 'primary', startDate: '2025-01-01', endDate: '2026-12-31' },
  { identifier: '2176', name: 'Illinois 104th General Assembly', classification: 'primary', startDate: '2025-01-01', endDate: '2026-12-31' },
  { identifier: '2234', name: 'Indiana 2026 Regular Session', classification: 'primary', startDate: '2026-01-01', endDate: '2026-12-31' },
  { identifier: '2199', name: '119th Congress', classification: 'primary', startDate: '2025-01-01', endDate: '2026-12-31' },
]

const MODULES: Record<string, DemoSeedModule> = {
  // Left off deliberately so a visitor can turn them on in Settings — the one
  // interaction a read-only demo preserves. The reset puts them back.
  'waiting-for-vote': false,
  'upcoming-hearings': false,
  calendar: true,
  // Shown enabled but locked; runDigest hard-stops before sending in demo mode.
  'email-digest': { enabled: true, settings: { frequency: 'daily', weeklyDay: '1' } },
}

export const LM_ORG = {
  associationName: 'Lake Michigan Alliance',
  bannerText:
    "You're exploring a read-only demo — explore anything, but changes won't save. Data resets nightly. " +
    'The bills are real legislation from Michigan, Wisconsin, Illinois, Indiana, and Congress, but the ' +
    'organization, its staff, and the hearing dates are fictional.',
  orgNoun: 'organization',
  aiContext: `You are analyzing a bill for a regional organization working on Great Lakes water quality and drinking water infrastructure.

When writing the summary, start directly with an action verb or gerund phrase — do not begin with "This bill", "The bill", or the bill number (e.g. "Requires community water systems to...", "Establishes a grant program for...", "Prohibits the sale of..."). Be concise and proportional to the bill's complexity — a simple or narrow amendment warrants 1–2 sentences; a multi-part or substantive bill may warrant a short paragraph.`,
  relevanceQuestion: "Rate the bill's relevance to Great Lakes water quality and drinking water infrastructure.",
  tagTaxonomy: TAXONOMY,
  keywords: KEYWORDS,
  positionVocabulary: ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'],
  modules: MODULES,
  sessions: { data: SESSIONS },
  stateCoverage: ['MI', 'WI', 'IL', 'IN', 'US'] as string[],
}
