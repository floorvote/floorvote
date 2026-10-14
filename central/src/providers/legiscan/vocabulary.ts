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
      explainer: 'Written but not yet formally filed.',
    },
    0: {
      label: 'Pre-filed', stage: 'introduced', rank: 102, terminal: false,
      explainer: 'Filed before the session began.',
    },
    1: {
      label: 'Introduced', stage: 'introduced', rank: 103, terminal: false,
      explainer: 'Formally introduced in its first chamber.',
    },
    9: {
      label: 'Referred', stage: 'in_committee', rank: 201, terminal: false,
      explainer: 'Sent to a committee.',
    },
    11: {
      label: 'Report DNP', stage: 'in_committee', rank: 202, terminal: false,
      explainer: 'A committee reported it with a recommendation that it not pass.',
    },
    10: {
      label: 'Report Pass', stage: 'in_committee', rank: 203, terminal: false,
      explainer: 'A committee reported it with a recommendation that it pass.',
    },
    2: {
      label: 'Engrossed', stage: 'passed_one_chamber', rank: 301, terminal: false,
      explainer: 'Passed the chamber where it was introduced.',
    },
    3: {
      label: 'Enrolled', stage: 'passed', rank: 401, terminal: false,
      explainer: 'Passed both chambers in the same form.',
    },
    6: {
      label: 'Failed', stage: 'failed', rank: 501, terminal: true, changeLabel: 'Failed/Dead',
      explainer: 'Defeated or otherwise stopped. LegiScan reports this for only some states.',
    },
    5: {
      label: 'Vetoed', stage: 'vetoed', rank: 601, terminal: false,
      explainer: 'Vetoed by the governor.',
    },
    // Not terminal: Chaptered can follow.
    4: {
      label: 'Passed', stage: 'enacted', rank: 701, terminal: false,
      explainer: 'Signed into law, enacted without a signature, or, for a resolution, adopted.',
    },
    7: {
      label: 'Override', stage: 'enacted', rank: 702, terminal: true,
      explainer: "Enacted over the governor's veto.",
    },
    8: {
      label: 'Chaptered', stage: 'enacted', rank: 703, terminal: true,
      explainer: "Enacted and assigned a chapter number in the state's session laws.",
    },
  },

  billTypes: {
    B: { label: 'Bill' },
    R: { label: 'Resolution' },
    CR: { label: 'Concurrent Resolution' },
    JR: { label: 'Joint Resolution' },
    JRCA: { label: 'Joint Resolution Constitutional Amendment' },
    EO: { label: 'Executive Order' },
    CA: { label: 'Constitutional Amendment' },
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
    1: { label: 'Hearing', kind: 'hearing', explainer: 'A committee meeting on the bill, where the public can usually testify or submit written comments.' },
    2: { label: 'Executive Session', kind: 'markup', explainer: 'A committee meeting where members discuss and vote on bills. The public can usually watch but not testify.' },
    3: { label: 'Markup Session', kind: 'markup', explainer: 'A committee meeting where members amend the bill and vote on whether to report it.' },
  },

  // LegiScan's SAST types (see docs/internal/legiscan-api.md). Only the two
  // that name the same bill filed twice are identical. Similar To, Replaces,
  // Replaced By, Enabling For, Enabled By, Related, and Carry Over stay related.
  relationships: {
    default: {
      'Same As': 'identical',
      'Crossfiled': 'identical',
    },
    states: {
      // Michigan files tie-barred packages of different bills as "Same As."
      MI: { 'Same As': 'package' },
    },
  },
}
