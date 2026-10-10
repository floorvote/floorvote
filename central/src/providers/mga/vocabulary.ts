import type { ProviderVocabulary } from '../sdk'

/**
 * Maryland's statuses (the codes `mgaStatus` derives in map.ts), bill types,
 * calendar event types, and extras.
 *
 * The session file has no status codes of its own: its Status field is the
 * last action as free text. So the codes are Maryland's own, MGA_STATUS_BASE
 * (200) plus the step's place on Maryland's path, and never LegiScan's 0–12.
 * Instances store the label, stage, and rank central sends, not the code, so
 * the two ranges couldn't collide there. Keeping them apart still matters in
 * central: a code read with the wrong provider's vocabulary goes out as its
 * bare number with rank 0, where a borrowed LegiScan code would pass as a
 * LegiScan status (an instance reads a bare "5" as Vetoed).
 *
 * Explainers follow the General Assembly's own guide
 * (https://msa.maryland.gov/msa/mdmanual/07leg/html/proc.html) and the
 * Maryland Constitution, Article II, Section 17. Keep the wording factual:
 * these appear next to real bills.
 */
export const MGA_STATUS_BASE = 200

export const vocabulary: ProviderVocabulary = {
  statuses: {
    201: {
      label: 'Pre-filed', stage: 'introduced', rank: 101, terminal: false,
      explainer: 'Filed before the session began. It gets its first reading, and goes to a committee, once the session starts.',
    },
    202: {
      label: 'In committee', stage: 'in_committee', rank: 201, terminal: false,
      explainer: 'Read for the first time and referred to a committee, which usually holds a hearing before it votes on the bill.',
    },
    203: {
      label: 'Reported favorably', stage: 'in_committee', rank: 202, terminal: false,
      explainer: 'Given a favorable report by its committee, perhaps with amendments. It goes to the floor of its chamber for second and third reading.',
    },
    204: {
      label: 'Passed the House', stage: 'passed_one_chamber', rank: 301, terminal: false,
      explainer: 'Passed by the House, where it started, and sent to the Senate.',
    },
    205: {
      label: 'Passed the Senate', stage: 'passed_one_chamber', rank: 302, terminal: false,
      explainer: 'Passed by the Senate, where it started, and sent to the House.',
    },
    206: {
      label: 'Passed the General Assembly', stage: 'passed', rank: 401, terminal: false,
      explainer: 'Passed by both chambers in the same form and presented to the Governor, who can sign it, veto it, or let it become law unsigned.',
    },
    207: {
      label: 'Unfavorable report', stage: 'failed', rank: 501, terminal: true,
      explainer: 'Given an unfavorable report by a committee, which ends the bill for the session unless the chamber overrules the committee.',
    },
    208: {
      label: 'Failed', stage: 'failed', rank: 502, terminal: true,
      explainer: 'Failed on third reading, the final vote in a chamber.',
    },
    209: {
      label: 'Postponed indefinitely', stage: 'failed', rank: 503, terminal: true,
      explainer: 'Postponed with no date for further action, which ends it for the session.',
    },
    210: {
      label: 'Withdrawn', stage: 'failed', rank: 504, terminal: true,
      explainer: 'Withdrawn by its sponsor.',
    },
    211: {
      label: 'Vetoed by the Governor', stage: 'vetoed', rank: 601, terminal: false,
      explainer: 'Vetoed by the Governor. Three-fifths of each chamber can override the veto. A bill vetoed after the session ends goes back to the General Assembly at its next session.',
    },
    212: {
      label: 'Adopted', stage: 'enacted', rank: 701, terminal: true,
      explainer: 'Adopted by its chamber, for a House or Senate resolution, or by the General Assembly, for a joint resolution. Some joint resolutions take effect without a vote, unless the General Assembly rejects them in time.',
    },
    213: {
      label: 'Approved by the Governor', stage: 'enacted', rank: 702, terminal: true,
      explainer: 'Signed by the Governor and given a chapter number in the session laws. Most acts take effect on the next October 1, and an emergency act when it is signed.',
    },
    214: {
      label: 'Enacted without the Governor\'s signature', stage: 'enacted', rank: 703, terminal: true,
      explainer: 'Became law without the Governor\'s signature, because the Governor neither signed nor vetoed it in time (Maryland Constitution, Article II, Section 17(c)).',
    },
    215: {
      label: 'Enacted over the Governor\'s veto', stage: 'enacted', rank: 704, terminal: true,
      explainer: 'Became law after three-fifths of each chamber voted to override the Governor\'s veto.',
    },
    216: {
      label: 'Enacted, subject to referendum', stage: 'enacted', rank: 705, terminal: false,
      explainer: 'Enacted, but it takes effect only if voters approve it at the next general election. A constitutional amendment always goes to the voters.',
    },
  },

  billTypes: {
    B: { label: 'Bill', explainer: 'A proposed law. It becomes law if both chambers pass it and the Governor signs it, lets it become law unsigned, or has a veto overridden.' },
    R: { label: 'Resolution', explainer: 'A statement or decision of the House or the Senate alone. It doesn\'t make law, and doesn\'t go to the Governor.' },
    JR: { label: 'Joint Resolution', explainer: 'A resolution of both chambers. Most state the General Assembly\'s position. Some have legal effect, such as one setting officials\' salaries, which takes effect unless the General Assembly rejects it.' },
  },

  eventTypes: {
    1: { label: 'Hearing', kind: 'hearing', explainer: 'A committee hearing on the bill, where the public can testify or submit written testimony.' },
  },

  extras: {
    chapter: {
      label: 'Chapter', display: 'identifier',
      explainer: 'Where the act is printed in the session laws (the Laws of Maryland) for its year, or the joint resolution\'s number.',
    },
    statutes: {
      label: 'Statutes affected', display: 'text',
      explainer: 'The articles and sections of the Annotated Code of Maryland the bill adds, amends, or repeals.',
    },
    emergency: {
      label: 'Emergency bill', display: 'text',
      explainer: 'Takes effect as soon as the Governor signs it, rather than on a later date. Passing it takes three-fifths of each chamber.',
    },
    constitutionalAmendment: {
      label: 'Constitutional amendment', display: 'text',
      explainer: 'Proposes an amendment to the Maryland Constitution. It needs three-fifths of each chamber, skips the Governor, and goes to the voters at the next general election.',
    },
    chamberInteraction: {
      label: 'Between the chambers', display: 'text',
      explainer: 'The latest step in settling differences between the House and Senate versions, such as a conference committee.',
    },
  },
}
