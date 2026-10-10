import type { ProviderVocabulary } from '../sdk'

/**
 * Virginia's statuses (the codes `lisStatus` derives in map.ts), bill types,
 * and calendar event types. The stages, ranks, and terminal flags are a first
 * pass from the mapping; the Virginia provider ticket refines the explainers.
 */
export const vocabulary: ProviderVocabulary = {
  statuses: {
    1: {
      label: 'Introduced', stage: 'introduced', rank: 101, terminal: false,
      explainer: 'Introduced and sent to a committee.',
    },
    11: {
      label: 'Continued from last session', stage: 'in_committee', rank: 201, terminal: false,
      explainer: 'Carried over from the previous session and pending again in committee.',
    },
    9: {
      label: 'Continued to next session', stage: 'in_committee', rank: 202, terminal: false,
      explainer: 'Carried over by a committee to the next session, when it can still be taken up.',
    },
    2: {
      label: 'Passed the House', stage: 'passed_one_chamber', rank: 301, terminal: false,
      explainer: 'Passed by the House. Both chambers still have to agree on one version before it goes to the Governor.',
    },
    3: {
      label: 'Passed the Senate', stage: 'passed_one_chamber', rank: 302, terminal: false,
      explainer: 'Passed by the Senate. Both chambers still have to agree on one version before it goes to the Governor.',
    },
    4: {
      label: 'Passed the General Assembly', stage: 'passed', rank: 401, terminal: false,
      explainer: 'Passed by both chambers in the same form and sent to the Governor.',
    },
    10: {
      label: 'Failed', stage: 'failed', rank: 501, terminal: true,
      explainer: 'Did not pass.',
    },
    7: {
      label: 'Vetoed by the Governor', stage: 'vetoed', rank: 601, terminal: false,
      explainer: 'Vetoed by the Governor. The General Assembly can still override the veto, usually at its reconvened session.',
    },
    8: {
      label: 'Agreed to', stage: 'enacted', rank: 701, terminal: true,
      explainer: 'A resolution agreed to by the General Assembly.',
    },
    5: {
      label: 'Approved by the Governor', stage: 'enacted', rank: 702, terminal: true,
      explainer: 'Approved by the Governor, which makes it law.',
    },
    6: {
      label: 'Enacted', stage: 'enacted', rank: 703, terminal: true,
      explainer: 'Became law, with a chapter number, without the Governor\'s approval.',
    },
  },

  billTypes: {
    B: { label: 'Bill', explainer: 'A proposed law. It becomes law if both chambers pass it and the Governor approves it, lets it become law unsigned, or has a veto overridden.' },
    R: { label: 'Resolution', explainer: 'A statement or decision of one chamber. It doesn\'t make law.' },
    JR: { label: 'Joint Resolution', explainer: 'A resolution of both chambers, such as a proposed constitutional amendment or a confirmation of appointments.' },
  },

  eventTypes: {
    1: { label: 'Hearing', kind: 'hearing', explainer: 'A committee or subcommittee meeting with the bill on its docket.' },
  },
}
