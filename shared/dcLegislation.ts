/**
 * Plain-language explainers for DC Council legislation types and statuses, as
 * LIMS names them. Shown as tooltips on DC bills so a team member can tell an
 * emergency act from a permanent one, and know what a status means for timing.
 *
 * Durations and review periods follow the Council's own summary
 * (DC_LEGISLATION_GUIDE_URL) and the Home Rule Act. Keep the wording factual:
 * these appear next to real bills.
 */
export const DC_LEGISLATION_GUIDE_URL = 'https://dccouncil.gov/how-a-bill-becomes-a-law/'

const TYPES: Record<string, string> = {
  'emergency bill':
    'Emergency act: takes effect once the Mayor signs it (or the Council overrides a veto) and lasts no more than 90 days. It skips the second reading and Congressional review, so the Council usually passes a temporary version at the same time.',
  'temporary bill':
    'Temporary act: lasts no more than 225 days. It goes through a second reading, Mayoral review, and Congressional review, and usually keeps an emergency act\'s policy in place until a permanent version takes effect.',
  'permanent bill':
    'Permanent act: changes DC law until it is repealed. After two readings and the Mayor\'s signature, it goes to Congress for review, 30 days or 60 days for certain criminal legislation, and becomes law only when that period ends. Review days count only days Congress is in session, so the projected law date is an estimate.',
  'congressional review emergency bill':
    'Congressional review emergency act: an emergency act that keeps a policy in force while its permanent version waits out Congressional review. Lasts no more than 90 days.',
  'emergency declaration resolution':
    'Emergency declaration: the Council\'s finding that emergency circumstances exist, which it adopts before voting on the matching emergency act.',
  'congressional review emer. decl. resolution':
    'Emergency declaration for a congressional review emergency act: the Council\'s finding that the policy must stay in force while the permanent act is under Congressional review.',
  'proposed resolution':
    'Resolution: a Council decision by vote, often a confirmation, appointment, or approval. Resolutions generally take effect when adopted, without Mayoral or Congressional review.',
  'ceremonial resolution':
    'Ceremonial resolution: recognizes a person, group, or occasion. It does not change the law.',
  'emergency approval resolution':
    'Emergency approval resolution: approves a matter, often a contract or financing, on an emergency basis.',
  'disapproval resolution':
    'Disapproval resolution: rejects a proposal sent to the Council for review, such as proposed rules or a reorganization plan.',
}

const STATUSES: Record<string, string> = {
  'under council review': 'Introduced and pending before the Council: in committee or awaiting a vote.',
  'under mayoral review': 'Passed by the Council and sent to the Mayor, who has 10 working days to sign or veto it. Unsigned, it takes effect as if signed; a veto can be overridden by two-thirds of the Council.',
  'enacted': 'Signed by the Mayor (or passed over a veto) and given an act number. An emergency act is now in effect; a temporary or permanent act still goes to Congress for review.',
  'under congressional review': 'Sent to Congress, which has a review period (30 days, or 60 for certain criminal legislation, counting only days Congress is in session) to disapprove it. If Congress does not act, it becomes law when the period ends.',
  'official law': 'Survived Congressional review and is now DC law, with a law number.',
  'vetoed': 'Vetoed by the Mayor. The Council can override with a two-thirds vote.',
  'expired': 'Ended without becoming law, or reached the end of its limited term (90 days for emergency acts, 225 for temporary acts).',
  'withdrawn': 'Withdrawn by its introducer.',
  'tabled': 'Set aside by the Council without a final vote.',
  'approved': 'Approved by the Council.',
  'deemed approved': 'Approved automatically because the Council did not act within its review period.',
  'deemed disapproved': 'Disapproved automatically because the Council did not approve it within its review period.',
  'disapproved': 'Rejected by the Council.',
  'failed': 'Did not pass.',
  'postponed indefinitely': 'Put off with no date for further action.',
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

/** Explainer for a LIMS legislation type ("Emergency Bill", "Proposed Resolution", ...), or null. */
export function dcTypeExplainer(type: string | null | undefined): string | null {
  return TYPES[norm(type)] ?? null
}

/** Explainer for a LIMS status ("Under Congressional Review", ...), or null. */
export function dcStatusExplainer(status: string | null | undefined): string | null {
  return STATUSES[norm(status)] ?? null
}
