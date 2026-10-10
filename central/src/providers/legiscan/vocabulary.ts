import type { ProviderVocabulary } from '../sdk'

/**
 * LegiScan's status codes (its Status / Progress table), bill types, and
 * calendar event types. Bills carry 0 to 6. Codes 7 to 12 are progress events
 * LegiScan rarely puts in `status`, but some stored bills have them.
 *
 * The ranks keep the order instances have always sorted LegiScan statuses in:
 * Draft, Pre-filed, Introduced, Referred, Report DNP, Report Pass, Engrossed,
 * Enrolled, Failed, Vetoed, Passed, Override, Chaptered.
 */
export const vocabulary: ProviderVocabulary = {
  statuses: {
    12: {
      label: 'Draft', stage: 'introduced', rank: 101, terminal: false,
      explainer: 'A draft that hasn\'t been formally filed yet.',
    },
    0: {
      label: 'Pre-filed', stage: 'introduced', rank: 102, terminal: false,
      explainer: 'Filed ahead of the session. It is formally introduced once the session begins.',
    },
    1: {
      label: 'Introduced', stage: 'introduced', rank: 103, terminal: false,
      explainer: 'Introduced in its first chamber. Most bills go to a committee next, and many get no further.',
    },
    9: {
      label: 'Referred', stage: 'in_committee', rank: 201, terminal: false,
      explainer: 'Sent to a committee, which decides whether it goes to the floor.',
    },
    11: {
      label: 'Report DNP', stage: 'in_committee', rank: 202, terminal: false,
      explainer: 'Reported by a committee with a recommendation that it not pass.',
    },
    10: {
      label: 'Report Pass', stage: 'in_committee', rank: 203, terminal: false,
      explainer: 'Reported favorably by a committee, which sends it on toward a floor vote.',
    },
    2: {
      label: 'Engrossed', stage: 'passed_one_chamber', rank: 301, terminal: false,
      explainer: 'Passed its first chamber, with any amendments made there, and sent to the second chamber.',
    },
    3: {
      label: 'Enrolled', stage: 'passed', rank: 401, terminal: false,
      explainer: 'Passed by both chambers in the same form and sent to the governor, or on to its final step.',
    },
    6: {
      label: 'Failed', stage: 'failed', rank: 501, terminal: true, changeLabel: 'Failed/Dead',
      explainer: 'Defeated in a vote or otherwise stopped. Only some states report this, so a bill that quietly died may still show an earlier status.',
    },
    5: {
      label: 'Vetoed', stage: 'vetoed', rank: 601, terminal: false,
      explainer: 'Vetoed by the governor. The legislature can still override the veto.',
    },
    4: {
      label: 'Passed', stage: 'enacted', rank: 701, terminal: true,
      explainer: 'Signed by the governor or otherwise enacted. For a resolution, adopted.',
    },
    7: {
      label: 'Override', stage: 'enacted', rank: 702, terminal: true,
      explainer: 'Enacted after the legislature overrode the governor\'s veto.',
    },
    8: {
      label: 'Chaptered', stage: 'enacted', rank: 703, terminal: true,
      explainer: 'Enacted and given a chapter number in the state\'s session laws.',
    },
  },

  billTypes: {
    B: { label: 'Bill', explainer: 'A proposed law. It becomes law only if both chambers pass it and the governor signs it or the legislature overrides a veto.' },
    R: { label: 'Resolution', explainer: 'A decision or statement of one chamber. It doesn\'t make law.' },
    CR: { label: 'Concurrent Resolution', explainer: 'A resolution both chambers adopt, usually about their own operations or a shared statement. It doesn\'t go to the governor.' },
    JR: { label: 'Joint Resolution', explainer: 'A resolution both chambers pass. Depending on the state and subject, it can have the force of law or propose a constitutional amendment.' },
    JRCA: { label: 'Joint Resolution Constitutional Amendment', explainer: 'A joint resolution proposing a change to the state constitution, which voters usually have to approve.' },
    EO: { label: 'Executive Order' },
    CA: { label: 'Constitutional Amendment', explainer: 'A proposed change to the state constitution, which voters usually have to approve.' },
    M: { label: 'Memorial' },
    CL: { label: 'Claim' },
    C: { label: 'Commendation' },
    CSR: { label: 'Committee Study Request' },
    JM: { label: 'Joint Memorial' },
    P: { label: 'Proclamation' },
    SR: { label: 'Study Request' },
    A: { label: 'Address' },
    CM: { label: 'Concurrent Memorial' },
    I: { label: 'Initiative' },
    PET: { label: 'Petition' },
    SB: { label: 'Study Bill' },
    IP: { label: 'Initiative Petition' },
    RB: { label: 'Repeal Bill' },
    RM: { label: 'Remonstration' },
    CB: { label: 'Committee Bill' },
  },

  eventTypes: {
    1: { label: 'Hearing', explainer: 'A committee meeting on the bill, where the public can usually testify or submit written comments.' },
    2: { label: 'Executive Session', explainer: 'A committee meeting where members discuss and vote on bills. The public can usually watch but not testify.' },
    3: { label: 'Markup Session', explainer: 'A committee meeting where members amend the bill and vote on whether to report it.' },
  },
}
