import type { ProviderVocabulary } from '../sdk'

/**
 * DC's statuses, legislation types, and calendar event types, as LIMS names
 * them.
 *
 * A status code is LIMS_STATUS_BASE (100) plus the LIMS status id (GET
 * LegislationStatus), and its label is the LIMS name, which map.ts reads
 * statuses by. 100 is a measure with no status: "Not Applicable", or blank.
 * DC's own stages (Mayoral and Congressional review, enacted versus official
 * law, deemed approved) are what advocates act on, and LegiScan's codes would
 * flatten them.
 *
 * The explainers come from @anotherpanacea's DC explainers (#216). Durations
 * and review periods follow the Council's own summary
 * (https://dccouncil.gov/how-a-bill-becomes-a-law/) and the Home Rule Act.
 * Keep the wording factual: these appear next to real bills.
 */
export const vocabulary: ProviderVocabulary = {
  statuses: {
    // No stage: a hearing notice isn't on the legislative path, so a stage
    // filter leaves it out. Terminal, since a notice's changes reach its
    // BulkData record, which the sync compares, and its details never move.
    100: {
      label: 'Not Applicable', stage: null, rank: 0, terminal: true,
      explainer: 'This measure doesn\'t move through the Council\'s legislative steps, so it has no status. Hearing notices are an example.',
    },
    101: {
      label: 'New', stage: 'introduced', rank: 101, terminal: false,
      explainer: 'Filed with the Council and not yet under review.',
    },
    114: {
      label: 'Under Council Review', stage: 'in_committee', rank: 201, terminal: false,
      explainer: 'Introduced and pending before the Council: in committee or awaiting a vote.',
    },
    110: {
      label: 'Under Mayoral Review', stage: 'passed', rank: 401, terminal: false,
      explainer: 'Passed by the Council and sent to the Mayor, who has 10 working days to sign or veto it. Unsigned, it takes effect as if signed; a veto can be overridden by two-thirds of the Council.',
    },
    113: {
      label: 'Tabled', stage: 'failed', rank: 501, terminal: false,
      explainer: 'Set aside by the Council without a final vote.',
    },
    119: {
      label: 'Postponed Indefinitely', stage: 'failed', rank: 502, terminal: false,
      explainer: 'Put off with no date for further action.',
    },
    107: {
      label: 'Withdrawn', stage: 'failed', rank: 503, terminal: true,
      explainer: 'Withdrawn by its introducer.',
    },
    111: {
      label: 'Failed', stage: 'failed', rank: 504, terminal: true,
      explainer: 'Did not pass.',
    },
    112: {
      label: 'Disapproved', stage: 'failed', rank: 505, terminal: true,
      explainer: 'Rejected by the Council.',
    },
    118: {
      label: 'Deemed Disapproved', stage: 'failed', rank: 506, terminal: true,
      explainer: 'Disapproved automatically because the Council did not approve it within its review period.',
    },
    109: {
      label: 'Vetoed', stage: 'vetoed', rank: 601, terminal: false,
      explainer: 'Vetoed by the Mayor. The Council can override with a two-thirds vote.',
    },
    // Not terminal (#283): a measure's record can still change after it is
    // approved, so the details refresh keeps checking it.
    115: {
      label: 'Approved', stage: 'enacted', rank: 701, terminal: false,
      explainer: 'Approved by the Council.',
    },
    117: {
      label: 'Deemed Approved', stage: 'enacted', rank: 702, terminal: false,
      explainer: 'Approved automatically because the Council did not act within its review period.',
    },
    108: {
      label: 'Enacted', stage: 'enacted', rank: 703, terminal: false,
      explainer: 'Signed by the Mayor (or passed over a veto) and given an act number. An emergency act is now in effect; a temporary or permanent act still goes to Congress for review.',
    },
    106: {
      label: 'Under Congressional Review', stage: 'enacted', rank: 704, terminal: false,
      explainer: 'Sent to Congress, which has a review period (30 days, or 60 for certain criminal legislation, counting only days Congress is in session) to disapprove it. If Congress does not act, it becomes law when the period ends.',
    },
    105: {
      label: 'Official Law', stage: 'enacted', rank: 705, terminal: true,
      explainer: 'Survived Congressional review and is now DC law, with a law number.',
    },
    // Enacted, not failed: what expires is mostly emergency and temporary
    // acts, which were law until their term ran out. LegiScan keeps such an
    // act "Passed", so DC sorts and filters like every other state.
    121: {
      label: 'Expired', stage: 'enacted', rank: 706, terminal: true,
      explainer: 'Ended without becoming law, or reached the end of its limited term (90 days for emergency acts, 225 for temporary acts).',
    },
  },

  // By legislationSubCategory, or legislationCategory when that is blank.
  billTypes: {
    'Bill': { label: 'Bill' },
    'Resolution': { label: 'Resolution' },
    'Emergency Bill': {
      label: 'Emergency Bill',
      explainer: 'Emergency act: takes effect once the Mayor signs it (or the Council overrides a veto) and lasts no more than 90 days. It skips the second reading and Congressional review, so the Council usually passes a temporary version at the same time.',
    },
    'Temporary Bill': {
      label: 'Temporary Bill',
      explainer: 'Temporary act: lasts no more than 225 days. It goes through a second reading, Mayoral review, and Congressional review, and usually keeps an emergency act\'s policy in place until a permanent version takes effect.',
    },
    'Permanent Bill': {
      label: 'Permanent Bill',
      explainer: 'Permanent act: changes DC law until it is repealed. After two readings and the Mayor\'s signature, it goes to Congress for review, 30 days or 60 days for certain criminal legislation, and becomes law only when that period ends. Review days count only days Congress is in session, so the projected law date is an estimate.',
    },
    'Congressional Review Emergency Bill': {
      label: 'Congressional Review Emergency Bill',
      explainer: 'Congressional review emergency act: an emergency act that keeps a policy in force while its permanent version waits out Congressional review. Lasts no more than 90 days.',
    },
    'Emergency Declaration Resolution': {
      label: 'Emergency Declaration Resolution',
      explainer: 'Emergency declaration: the Council\'s finding that emergency circumstances exist, which it adopts before voting on the matching emergency act.',
    },
    'Congressional Review Emer. Decl. Resolution': {
      label: 'Congressional Review Emer. Decl. Resolution',
      explainer: 'Emergency declaration for a congressional review emergency act: the Council\'s finding that the policy must stay in force while the permanent act is under Congressional review.',
    },
    'Proposed Resolution': {
      label: 'Proposed Resolution',
      explainer: 'Resolution: a Council decision by vote, often a confirmation, appointment, or approval. Resolutions generally take effect when adopted, without Mayoral or Congressional review.',
    },
    'Ceremonial Resolution': {
      label: 'Ceremonial Resolution',
      explainer: 'Ceremonial resolution: recognizes a person, group, or occasion. It does not change the law.',
    },
    'Emergency Approval Resolution': {
      label: 'Emergency Approval Resolution',
      explainer: 'Emergency approval resolution: approves a matter, often a contract or financing, on an emergency basis.',
    },
    'Disapproval Resolution': {
      label: 'Disapproval Resolution',
      explainer: 'Disapproval resolution: rejects a proposal sent to the Council for review, such as proposed rules or a reorganization plan.',
    },
    'Oversight Hearing/Roundtable Notice': {
      label: 'Oversight Hearing/Roundtable Notice',
      explainer: 'Hearing notice: a committee\'s public notice of a hearing or roundtable on an agency, a budget, or an issue, with no bill attached. The notice says how to sign up to testify or submit written testimony.',
    },
    'Reprogramming': {
      label: 'Reprogramming',
      explainer: 'Reprogramming: a request to move budgeted money from one program or purpose to another. It is deemed approved 14 days after the Council receives it, or 30 days if a Councilmember files a disapproval resolution, unless the Council disapproves it first (DC Code 47-363).',
    },
    'Grant Budget Modification': {
      label: 'Grant Budget Modification',
      explainer: 'Grant budget modification: notice of a change to an agency\'s grant-funded budget, such as accepting a new federal or private grant, filed with the Council for review.',
    },
  },

  eventTypes: {
    1: { label: 'Hearing', explainer: 'A Council committee hearing or roundtable, where the public can testify or submit written testimony.' },
    3: { label: 'Markup Session', explainer: 'A committee meeting where Councilmembers amend the measure and vote on whether to send it to the full Council.' },
  },

  calendarName: 'DC Council calendar',

  // Shown on the bill page under "Additional information from DC Council", in
  // this order. map.ts fills them, and inventory.ts says which feed field each
  // comes from.
  extras: {
    lawNumber: {
      label: 'D.C. Law number', display: 'identifier',
      explainer: 'The number an act takes when it becomes law after Congressional review.',
    },
    actNumber: {
      label: 'Act number', display: 'identifier',
      explainer: 'The number a measure takes when it is enacted: signed by the Mayor, left unsigned past the Mayor\'s deadline, or passed over a veto.',
    },
    resolutionNumber: {
      label: 'Resolution number', display: 'identifier',
      explainer: 'The number a resolution takes when the Council adopts it.',
    },
    requestedBy: {
      label: 'Introduced at the request of', display: 'text',
      explainer: 'Who asked for the measure. The Chairman often introduces measures at the request of the Mayor.',
    },
    commentCommittees: {
      label: 'Committees asked for comments', display: 'text',
      explainer: 'Committees that may comment on the measure. The committee it was referred to, or the full Council, still acts on it.',
    },
    sentToMayor: { label: 'Sent to the Mayor', display: 'date' },
    mayorDeadline: {
      label: 'Mayor\'s deadline', display: 'date',
      explainer: 'The Mayor has 10 working days to sign or veto an act. Unsigned by then, it takes effect as if signed.',
    },
    signedByMayor: { label: 'Signed by the Mayor', display: 'date' },
    vetoedByMayor: { label: 'Vetoed by the Mayor', display: 'date' },
    enacted: { label: 'Enacted', display: 'date' },
    actExpires: {
      label: 'Act expires', display: 'date',
      explainer: 'Emergency acts last no more than 90 days, and temporary acts no more than 225.',
    },
    sentToCongress: { label: 'Sent to Congress', display: 'date' },
    projectedLawDate: {
      label: 'Projected law date', display: 'date',
      explainer: 'When Congressional review is expected to end. Review counts only days Congress is in session, so this is an estimate.',
    },
    lawEffective: { label: 'Law effective', display: 'date' },
    lawExpires: {
      label: 'Law expires', display: 'date',
      explainer: 'A temporary law lasts no more than 225 days.',
    },
    withdrawnBy: { label: 'Withdrawn by', display: 'text' },
    withdrawnOn: { label: 'Withdrawn on', display: 'date' },
  },
}
