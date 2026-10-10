import type { ProviderVocabulary } from '../sdk'

/**
 * Maryland's statuses (the codes `mgaStatus` derives in map.ts), bill types,
 * and calendar event types. The stages, ranks, and terminal flags are a first
 * pass from the mapping; the Maryland provider ticket refines the explainers.
 */
export const vocabulary: ProviderVocabulary = {
  statuses: {
    1: {
      label: 'Pre-filed', stage: 'introduced', rank: 101, terminal: false,
      explainer: 'Filed before the session began. It gets its first reading once the session starts.',
    },
    2: {
      label: 'Introduced', stage: 'introduced', rank: 102, terminal: false,
      explainer: 'Read for the first time in its chamber of origin and sent to a committee.',
    },
    3: {
      label: 'Passed the House', stage: 'passed_one_chamber', rank: 301, terminal: false,
      explainer: 'Passed by the House, where it started, and sent to the Senate.',
    },
    4: {
      label: 'Passed the Senate', stage: 'passed_one_chamber', rank: 302, terminal: false,
      explainer: 'Passed by the Senate, where it started, and sent to the House.',
    },
    5: {
      label: 'Passed the General Assembly', stage: 'passed', rank: 401, terminal: false,
      explainer: 'Passed by both chambers and presented to the Governor.',
    },
    12: {
      label: 'Unfavorable report', stage: 'failed', rank: 501, terminal: true,
      explainer: 'Given an unfavorable report by a committee, which usually ends the bill for the session.',
    },
    14: {
      label: 'Postponed indefinitely', stage: 'failed', rank: 502, terminal: true,
      explainer: 'Postponed with no date for further action, which ends it for the session.',
    },
    13: {
      label: 'Withdrawn', stage: 'failed', rank: 503, terminal: true,
      explainer: 'Withdrawn by its sponsor.',
    },
    11: {
      label: 'Vetoed by the Governor', stage: 'vetoed', rank: 601, terminal: false,
      explainer: 'Vetoed by the Governor. The General Assembly can still override the veto.',
    },
    10: {
      label: 'Adopted', stage: 'enacted', rank: 701, terminal: true,
      explainer: 'A joint resolution adopted by the General Assembly.',
    },
    6: {
      label: 'Approved by the Governor', stage: 'enacted', rank: 702, terminal: true,
      explainer: 'Signed by the Governor and given a chapter number in the session laws.',
    },
    7: {
      label: 'Enacted without the Governor\'s signature', stage: 'enacted', rank: 703, terminal: true,
      explainer: 'Became law without the Governor\'s signature, as the Maryland Constitution allows.',
    },
    8: {
      label: 'Enacted over the Governor\'s veto', stage: 'enacted', rank: 704, terminal: true,
      explainer: 'Became law after the General Assembly overrode the Governor\'s veto.',
    },
    9: {
      label: 'Enacted, subject to referendum', stage: 'enacted', rank: 705, terminal: false,
      explainer: 'Enacted, but it takes effect only if voters approve it at a referendum.',
    },
  },

  billTypes: {
    B: { label: 'Bill', explainer: 'A proposed law. It becomes law if both chambers pass it and the Governor signs it, lets it become law unsigned, or has a veto overridden.' },
    R: { label: 'Resolution', explainer: 'A statement or decision of one chamber. It doesn\'t make law.' },
    JR: { label: 'Joint Resolution', explainer: 'A resolution of both chambers, often a statement of the General Assembly\'s position.' },
  },

  eventTypes: {
    1: { label: 'Hearing', kind: 'hearing', explainer: 'A committee hearing on the bill, where the public can testify or submit written testimony.' },
  },
}
