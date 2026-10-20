import type { DemoSeedModule, DemoSeedSession } from '../types'
import type { TaxonomyItem } from '../../taxonomy'
import { LEGISCAN_ATTRIBUTION } from '../../../../../shared/dataAttribution'

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
// This demo's bills are pinned by externalId in bills.ts, so these keywords gate
// nothing -- they exist for a visitor to read on the Config page. So they are
// written the way a thoughtful person would actually type them: bare, with a
// trailing star only where the plural is the common form.
const KEYWORDS = [
  'pfas', 'drinking water', 'great lakes', 'water quality', 'groundwater', 'wetland*',
  'lead service line*', 'erosion', 'stormwater', 'sewage', 'microplastic*',
  'invasive species', 'water withdrawal*', 'dredging', 'water utility', 'shoreline*',
  'harmful algal bloom*', 'water main*', 'septic', 'aquatic invasive', 'watershed*', 'beach*',
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
    'Congress — the organization, its staff, the hearing dates, and the most recent legislative ' +
    'activity are fictional. Anything you change resets every few hours.',
  orgNoun: 'alliance',
  aiContext: `You are analyzing a bill for a regional organization working on water quality in the Lake Michigan basin. Their work covers: drinking water safety and testing (including lead service line replacement and lead testing in schools), PFAS and other persistent contaminants, beach water quality and closure notification, septic systems and wastewater treatment, aquatic invasive species prevention, water withdrawals and groundwater protection, and shoreline erosion and habitat. They advocate and testify; they hold no regulatory or permitting authority themselves.

Note: they track four state legislatures — Michigan, Wisconsin, Illinois, and Indiana — plus Congress. State bills usually set standards, funding, or permitting duties for state agencies and local utilities, while federal bills more often authorize programs and appropriate money. Weigh a bill's relevance by its practical effect on water in the basin, not by which body passed it.

*How to write the summary*
- Open with one sentence stating the bill's main effect, starting with a verb ("Requires…", "Establishes…", "Prohibits…"). Never write "This bill", "The bill", or the bill number anywhere in the summary.
- If the bill is narrow or makes one main change, stop there or add one more sentence. Use no list.
- Otherwise, follow that sentence with a list of 2–8 items, most consequential first. Start each item with a short bold label naming what it governs, then a colon, then one sentence that starts with a verb and says who bears the duty. Keep each deadline, dollar amount, threshold, or penalty in the item it belongs to.
- If the bill states an effective date, make it the last item, labeled Effective date.
- Write no other prose, and use bold only for the item labels.

Many of the bills you see will be short, procedural, or only tangentially related to water. When the text supports only a narrow description, give a narrow one — "Extends the sunset date for the state well-testing program to 2030." is a complete summary, and padding it out to sound substantive is worse than leaving it brief. If the available text is too thin to tell what the bill actually does, describe what it appears to do and stop there.

Describe what the bill does, not whether it is good policy. The organization records its own stance separately as an official position, and takes one on only a small share of what it tracks — so a summary should read the same whether they end up supporting the bill, opposing it, or never taking a view. Don't predict whether a bill will pass.`,
  relevanceQuestion: "Rate the bill's relevance to Great Lakes water quality and drinking water infrastructure.",
  tagTaxonomy: TAXONOMY,
  keywords: KEYWORDS,
  positionVocabulary: ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'],
  modules: MODULES,
  sessions: { data: SESSIONS },
  stateCoverage: ['MI', 'WI', 'IL', 'IN', 'US'] as string[],
  // Every state and Congress here is on LegiScan. A live instance learns this from central; the demo never calls it.
  attribution: { providers: [{ id: 'legiscan', ...LEGISCAN_ATTRIBUTION }] },
}
