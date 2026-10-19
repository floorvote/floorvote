import type { ProviderVocabulary } from '../sdk'

/** The GovInfo provider's status codes start here (status.ts, GOVINFO_STATUS). */
export const GOVINFO_STATUS_BASE = 400

/**
 * Congress's statuses (the codes `deriveStatus` writes in status.ts), bill
 * types, relationship labels, and extras.
 *
 * Bill Status files carry no status of their own: a bill is a list of actions,
 * each with an action code and a type. So the codes are the provider's own,
 * GOVINFO_STATUS_BASE (400) plus the step's place on a bill's path, never
 * LegiScan's 0–12 or another provider's block. Instances store the label,
 * stage, and rank central sends, not the code, but in central a code read with
 * the wrong provider's vocabulary goes out as a bare number with rank 0.
 *
 * Explainers follow Congress's own account of how a bill becomes law
 * (https://www.congress.gov/legislative-process) and Article I, Section 7 of
 * the Constitution. Keep the wording factual: these appear next to real bills.
 */
export const vocabulary: ProviderVocabulary = {
  statuses: {
    [GOVINFO_STATUS_BASE + 1]: {
      label: 'Introduced', stage: 'introduced', rank: 101, terminal: false,
      explainer: 'Introduced in the House or Senate. Most bills are referred to a committee at once. A Senate measure placed straight on the calendar waits there for the full Senate, with no committee referral.',
    },
    [GOVINFO_STATUS_BASE + 2]: {
      label: 'In committee', stage: 'in_committee', rank: 201, terminal: false,
      explainer: 'Referred to a committee, which decides whether to hold hearings, amend the measure, and report it to the full chamber. Most measures never get past this step.',
    },
    [GOVINFO_STATUS_BASE + 3]: {
      label: 'Reported', stage: 'in_committee', rank: 202, terminal: false,
      explainer: 'Reported by its committee to the full chamber, or taken out of committee by a discharge, and waiting for a floor vote. A measure whose motion to proceed or to discharge was rejected stays here.',
    },
    [GOVINFO_STATUS_BASE + 4]: {
      label: 'Passed House', stage: 'passed_one_chamber', rank: 301, terminal: false,
      explainer: 'Passed by the House of Representatives. The Senate still has to pass it, and both chambers have to agree on one text before it goes to the President.',
    },
    [GOVINFO_STATUS_BASE + 5]: {
      label: 'Passed Senate', stage: 'passed_one_chamber', rank: 302, terminal: false,
      explainer: 'Passed by the Senate. The House still has to pass it, and both chambers have to agree on one text before it goes to the President.',
    },
    [GOVINFO_STATUS_BASE + 6]: {
      label: 'Passed both chambers', stage: 'passed', rank: 401, terminal: false,
      explainer: 'Passed by the House and the Senate. Once both agree on the same text, a bill or joint resolution is enrolled and presented to the President.',
    },
    [GOVINFO_STATUS_BASE + 7]: {
      label: 'Presented to the President', stage: 'passed', rank: 402, terminal: false,
      explainer: 'Presented to the President, who has ten days, not counting Sundays, to sign it or veto it. It becomes law without a signature after ten days if Congress is in session.',
    },
    [GOVINFO_STATUS_BASE + 8]: {
      label: 'Failed', stage: 'failed', rank: 501, terminal: false,
      explainer: 'Failed on a vote in its first chamber. A failed vote isn\'t always the end: a measure that fails under a motion to suspend the rules can come back under a rule, or be passed after a motion to reconsider.',
    },
    [GOVINFO_STATUS_BASE + 9]: {
      label: 'Vetoed', stage: 'vetoed', rank: 601, terminal: false,
      explainer: 'Vetoed by the President. It becomes law only if two-thirds of the House and two-thirds of the Senate vote to override the veto.',
    },
    [GOVINFO_STATUS_BASE + 10]: {
      label: 'Became law', stage: 'enacted', rank: 701, terminal: true,
      explainer: 'Became a public or private law, by the President\'s signature, after ten days without one, or over a veto. A public law has a number such as 119-15, for the Congress and the order it was enacted.',
    },
    [GOVINFO_STATUS_BASE + 11]: {
      label: 'Agreed to', stage: 'enacted', rank: 702, terminal: true,
      explainer: 'A resolution agreed to: by its own chamber, for a simple resolution, or by both chambers, for a concurrent resolution. Neither goes to the President, and neither makes law.',
    },
  },

  billTypes: {
    B: { label: 'Bill', explainer: 'A proposed law (H.R. or S.). It becomes law if both chambers pass it and the President signs it, lets it become law unsigned, or a veto is overridden.' },
    R: { label: 'Resolution', explainer: 'A simple resolution (H. Res. or S. Res.): a matter of one chamber alone, such as its rules or a commendation. It doesn\'t make law and doesn\'t go to the President.' },
    JR: { label: 'Joint Resolution', explainer: 'A joint resolution (H.J. Res. or S.J. Res.). It has the force of law like a bill, once passed by both chambers and signed, and it is also how Congress proposes a constitutional amendment, which skips the President.' },
    CR: { label: 'Concurrent Resolution', explainer: 'A concurrent resolution (H. Con. Res. or S. Con. Res.): a matter of both chambers, such as the budget resolution. It doesn\'t make law and doesn\'t go to the President.' },
  },

  // The kinds of a committee meeting (meetings.ts, meetingType). The Congress.gov API's own type is
  // wordier than these ("Open Hearing", "Closed Markup Session", "Open Business Meeting"), and
  // the Senate types most of its hearings "Meeting". Each entry and body event keeps the API's own
  // word as its type and takes its kind from the words in it: a markup, else a hearing, else a meeting.
  eventTypes: {
    1: {
      label: 'Hearing', kind: 'hearing',
      explainer: 'A committee or subcommittee hearing, where members hear testimony from witnesses on a bill or an issue. A hearing doesn\'t decide a bill.',
    },
    2: {
      label: 'Markup', kind: 'markup',
      explainer: 'A markup, where a committee amends a bill and votes on whether to report it to the full chamber. A bill is usually reported out of committee at one.',
    },
    3: {
      label: 'Meeting', kind: 'meeting',
      explainer: 'A committee meeting that isn\'t a hearing or a markup: a business meeting, a briefing, or any other kind the Library of Congress lists as a meeting. It lists many Senate hearings as meetings, and they appear here.',
    },
  },

  // The name of the calendar the committee meetings make, when the provider has a key to read them.
  calendarName: 'Congress committee meetings',

  // The fields Congress publishes that no other provider does. A later ticket
  // (the bill detail ingest) fills them; the keys are fixed here.
  extras: {
    summary: {
      label: 'Summary', display: 'text',
      explainer: 'The latest summary written by the Congressional Research Service of the Library of Congress. It describes the bill\'s most significant provisions, and the label says which version of the bill it covers.',
    },
    publicLaw: {
      label: 'Public law', display: 'identifier',
      explainer: 'The law\'s number: the Congress that enacted it and its order, such as 119-15. A private law is numbered the same way.',
    },
    policyArea: {
      label: 'Policy area', display: 'text',
      explainer: 'The one broad subject the Congressional Research Service files the measure under.',
    },
    costEstimate: {
      label: 'Cost estimate', display: 'link',
      explainer: 'The Congressional Budget Office\'s estimate of what the measure would cost, which the CBO publishes for most measures a committee reports.',
    },
  },

  // The labels the Library of Congress gives a related bill. Only "Identical
  // bill" names the same text filed in both chambers, which companion grouping
  // uses. Everything else is related, and is listed so each label is a
  // decision, not a default.
  relationships: {
    default: {
      'Identical bill': 'identical',
      'Related bill': 'related',
      'Procedurally related': 'related',
      'Cross-Congress related bill': 'related',
      'Contained in public law': 'related',
      'Public law contains the text': 'related',
      'PrimaryCompanionBillBecameLaw': 'related',
      'SecondaryCompanionBillBecameLaw': 'related',
    },
    identicalStates: ['US'],
  },
}
