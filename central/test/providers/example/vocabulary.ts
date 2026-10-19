import type { ProviderVocabulary } from '../../../src/providers/sdk'

/** The example provider's vocabulary: two statuses, one bill type, one event type, and five extras. */
export const vocabulary: ProviderVocabulary = {
  statuses: {
    1: { label: 'Introduced', stage: 'introduced', rank: 101, terminal: false, explainer: 'Filed and not yet acted on.' },
    2: { label: 'Enacted', stage: 'enacted', rank: 701, terminal: true, explainer: 'Signed into law.' },
  },
  billTypes: { B: { label: 'Bill' } },
  eventTypes: { 1: { label: 'Meeting', kind: 'meeting' } },
  // Declared in the order the bill page shows them.
  extras: {
    // One extra per placement. effectiveDate says none, which means the panel.
    lawNumber: { label: 'Law number', explainer: 'The number the measure took when it became law.', display: 'identifier', placement: 'meta' },
    effectiveDate: { label: 'Effective date', display: 'date' },
    packet: { label: 'Introduction packet', display: 'link', placement: 'panel' },
    withdrawnBy: { label: 'Withdrawn by', display: 'text', placement: 'detail' },
    becameLaw: { label: 'Became law', explainer: 'The measure was signed into law.', display: 'text', placement: 'flag' },
  },
}
