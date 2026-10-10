import type { ProviderVocabulary } from '../sdk'

/** Virginia's status codes start here (map.ts, LIS_STATUS). */
export const LIS_STATUS_BASE = 300

/**
 * Virginia's statuses (the codes `lisStatus` derives in map.ts), bill types,
 * calendar event types, and extras.
 *
 * The data files have no status codes of their own: BILLS.CSV carries flags
 * (passed each chamber, failed, carried over, approved, vetoed) and a chapter
 * number. So the codes are Virginia's own, LIS_STATUS_BASE (300) plus the
 * step's place on Virginia's path, never LegiScan's 0–12 or Maryland's 200s.
 * Instances store the label, stage, and rank central sends, not the code, but
 * in central a code read with the wrong provider's vocabulary then goes out
 * as an unknown number with rank 0, rather than passing as another
 * provider's status.
 *
 * Explainers follow the General Assembly's own description of how a bill
 * becomes law (https://virginiageneralassembly.gov/virginiaLegislature.php)
 * and Article V, Section 6 of the Constitution of Virginia.
 */
export const vocabulary: ProviderVocabulary = {
  statuses: {
    [LIS_STATUS_BASE + 1]: {
      label: 'Introduced', stage: 'introduced', rank: 101, terminal: false,
      explainer: 'Filed with the House or Senate clerk, and not yet referred to a committee.',
    },
    [LIS_STATUS_BASE + 2]: {
      label: 'In committee', stage: 'in_committee', rank: 201, terminal: false,
      explainer: 'Referred to a committee of the chamber it was introduced in, which decides whether to report it to the floor. Most bills that fail die in committee.',
    },
    [LIS_STATUS_BASE + 3]: {
      label: 'Continued from last session', stage: 'in_committee', rank: 202, terminal: false,
      explainer: 'Carried over from an earlier session by a committee vote, and pending again in that committee. It can be taken up this session.',
    },
    [LIS_STATUS_BASE + 4]: {
      label: 'Continued to next session', stage: 'in_committee', rank: 203, terminal: false,
      explainer: 'Carried over by a committee to a later session, usually the next year\'s regular session, where it can still be taken up.',
    },
    [LIS_STATUS_BASE + 5]: {
      label: 'Passed the House', stage: 'passed_one_chamber', rank: 301, terminal: false,
      explainer: 'Passed by the House of Delegates. The Senate still has to pass it, and both chambers have to agree on one version before it goes to the Governor.',
    },
    [LIS_STATUS_BASE + 6]: {
      label: 'Passed the Senate', stage: 'passed_one_chamber', rank: 302, terminal: false,
      explainer: 'Passed by the Senate. The House of Delegates still has to pass it, and both chambers have to agree on one version before it goes to the Governor.',
    },
    [LIS_STATUS_BASE + 7]: {
      label: 'Passed the General Assembly', stage: 'passed', rank: 401, terminal: false,
      explainer: 'Passed by both chambers in the same form and sent to the Governor, who can sign it, veto it, or return it with amendments for the General Assembly to consider at its reconvened session.',
    },
    [LIS_STATUS_BASE + 8]: {
      label: 'Failed', stage: 'failed', rank: 501, terminal: true,
      explainer: 'Did not pass: defeated on a vote, left in committee, stricken, or tabled.',
    },
    [LIS_STATUS_BASE + 9]: {
      label: 'Vetoed by the Governor', stage: 'vetoed', rank: 601, terminal: false,
      explainer: 'Vetoed by the Governor. Two-thirds of the members present in each chamber can override the veto, usually at the reconvened session.',
    },
    [LIS_STATUS_BASE + 10]: {
      label: 'Agreed to', stage: 'enacted', rank: 701, terminal: true,
      explainer: 'A resolution agreed to: by its own chamber, or by both chambers for a joint resolution. Resolutions don\'t go to the Governor.',
    },
    [LIS_STATUS_BASE + 11]: {
      label: 'Approved by the Governor', stage: 'enacted', rank: 702, terminal: true,
      explainer: 'Signed by the Governor, which makes it law. It is printed in the Acts of Assembly under a chapter number.',
    },
    [LIS_STATUS_BASE + 12]: {
      label: 'Enacted', stage: 'enacted', rank: 703, terminal: true,
      explainer: 'Became law, with a chapter number, without the Governor\'s signature: the Governor didn\'t act in time, or the General Assembly overrode a veto.',
    },
  },

  billTypes: {
    B: { label: 'Bill', explainer: 'A proposed law. It becomes law if both chambers pass it and the Governor approves it, lets it become law unsigned, or has a veto overridden.' },
    R: { label: 'Resolution', explainer: 'A statement or decision of one chamber, such as a commendation or a memorial. It doesn\'t make law.' },
    JR: { label: 'Joint Resolution', explainer: 'A resolution of both chambers, such as a proposed constitutional amendment, a study request, or a confirmation of appointments. It doesn\'t go to the Governor.' },
  },

  eventTypes: {
    1: { label: 'Hearing', explainer: 'A committee or subcommittee meeting with the bill on its docket.' },
  },

  extras: {
    chapter: {
      label: 'Chapter', display: 'identifier',
      explainer: 'Where the act is printed in the Acts of Assembly for its year.',
    },
    emergency: {
      label: 'Emergency bill', display: 'text',
      explainer: 'Takes effect as soon as it becomes law, rather than on July 1. Passing it takes four-fifths of the members voting in each chamber.',
    },
    summaryIntroduced: {
      label: 'Summary as introduced', display: 'text',
      explainer: 'The Division of Legislative Services\' summary of the bill as it was introduced. The bill\'s description is its latest summary.',
    },
    summaryPassedHouse: {
      label: 'Summary as passed the House', display: 'text',
      explainer: 'The summary of the bill as the House of Delegates passed it.',
    },
    summaryPassedSenate: {
      label: 'Summary as passed the Senate', display: 'text',
      explainer: 'The summary of the bill as the Senate passed it.',
    },
    summaryPassed: {
      label: 'Summary as passed the General Assembly', display: 'text',
      explainer: 'The summary of the bill as both chambers passed it, before the Governor\'s amendments.',
    },
  },
}
