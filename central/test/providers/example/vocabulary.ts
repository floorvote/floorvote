import type { ProviderVocabulary } from '../../../src/providers/sdk'

/** The example provider's vocabulary: two statuses, one bill type, and four extras. */
export const vocabulary: ProviderVocabulary = {
  statuses: {
    1: { label: 'Introduced', stage: 'introduced', rank: 101, terminal: false, explainer: 'Filed and not yet acted on.' },
    2: { label: 'Enacted', stage: 'enacted', rank: 701, terminal: true, explainer: 'Signed into law.' },
  },
  billTypes: { B: { label: 'Bill' } },
  eventTypes: {},
  // Declared in the order the bill page shows them.
  extras: {
    lawNumber: { label: 'Law number', explainer: 'The number the measure took when it became law.', display: 'identifier' },
    effectiveDate: { label: 'Effective date', display: 'date' },
    packet: { label: 'Introduction packet', display: 'link' },
    withdrawnBy: { label: 'Withdrawn by', display: 'text' },
  },
}
