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
    'Demo instance. The bills are real legislation from Michigan, Wisconsin, Illinois, Indiana, and ' +
    'Congress — the organization, its staff, and the hearing dates are fictional. Anything you change ' +
    'resets every few hours.',
  orgNoun: 'organization',
  aiContext: `You are analyzing a bill for a regional organization working on water quality in the Lake Michigan basin. Their work covers: drinking water safety and testing (including lead service line replacement and lead testing in schools), PFAS and other persistent contaminants, beach water quality and closure notification, septic systems and wastewater treatment, aquatic invasive species prevention, water withdrawals and groundwater protection, and shoreline erosion and habitat. They advocate and testify; they hold no regulatory or permitting authority themselves.

Note: they track four state legislatures — Michigan, Wisconsin, Illinois, and Indiana — plus Congress. State bills usually set standards, funding, or permitting duties for state agencies and local utilities, while federal bills more often authorize programs and appropriate money. Weigh a bill's relevance by its practical effect on water in the basin, not by which body passed it.

When writing the summary, start directly with an action verb or gerund phrase — do not begin with "This bill", "The bill", or the bill number. For example, you could start with "Requires community water systems to...", "Establishes a grant program for...", etc.

Scale the description to the bill's complexity and relevance. For less relevant, simple, or narrow bills 1–2 plain sentences should suffice. For bills that are longer and more relevant, you might write a paragraph or two. For a bill with multiple distinct provisions, you might also—or instead—use a list of 2–8 items, with the most impactful provisions first (unless there is some other order that would be more logical). Each item should start with a verb and be one sentence. You should aim to minimize redundancy in the description.

Many of the bills you see will be short, procedural, or only tangentially related to water. When the text supports only a narrow description, give a narrow one — "Extends the sunset date for the state well-testing program to 2030." is a complete summary, and padding it out to sound substantive is worse than leaving it brief. If the available text is too thin to tell what the bill actually does, describe what it appears to do and stop there.

Describe what the bill does, not whether it is good policy. The organization records its own stance separately as an official position, and takes one on only a small share of what it tracks — so a summary should read the same whether they end up supporting the bill, opposing it, or never taking a view. Don't predict whether a bill will pass.`,
  relevanceQuestion: "Rate the bill's relevance to Great Lakes water quality and drinking water infrastructure.",
  tagTaxonomy: TAXONOMY,
  keywords: KEYWORDS,
  positionVocabulary: ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'],
  modules: MODULES,
  sessions: { data: SESSIONS },
  stateCoverage: ['MI', 'WI', 'IL', 'IN', 'US'] as string[],
}
