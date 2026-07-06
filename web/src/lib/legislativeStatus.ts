// OpenStates action classification strings → human labels
// Legacy LegiScan numeric codes are left as pass-through fallbacks.
const STATUS_LABELS: Record<string, string> = {
  // OpenStates classifications
  'introduction': 'Introduced',
  'introduced': 'Introduced',
  'referral-committee': 'Referred',
  'referral': 'Referred',
  'committee-passage': 'Committee Passage',
  'committee-passage-favorable': 'Committee Passage',
  'committee-passage-unfavorable': 'Committee Unfavorable',
  'committee-failure': 'Committee Failure',
  'reading-1': '1st Reading',
  'reading-2': '2nd Reading',
  'reading-3': '3rd Reading',
  'amendment-introduction': 'Amendment Introduced',
  'amendment-passage': 'Amendment Passed',
  'amendment-failure': 'Amendment Failed',
  'amendment-withdrawal': 'Amendment Withdrawn',
  'passed': 'Passed',
  'passed_lower': 'Passed House',
  'passed_upper': 'Passed Senate',
  'failure': 'Failed',
  'withdrawal': 'Withdrawn',
  'executive-receipt': 'Sent to Governor',
  'executive-signature': 'Signed',
  'executive-veto': 'Vetoed',
  'executive-veto-line-item': 'Vetoed (Line Item)',
  'enacted': 'Enacted',
  'became-law': 'Became Law',
  // Legacy LegiScan numeric codes (pass-through if not matched above)
  '0': 'Pre-filed',
  '1': 'Introduced',
  '2': 'Engrossed',
  '3': 'Enrolled',
  '4': 'Passed',
  '5': 'Vetoed',
  '6': 'Failed',
  '7': 'Override',
  '8': 'Chaptered',
  '9': 'Referred',
  '10': 'Report Pass',
  '11': 'Report DNP',
  '12': 'Draft',
}

export function decodeStatus(status: string | null): string | null {
  if (!status) return null
  return STATUS_LABELS[status] ?? status
}

