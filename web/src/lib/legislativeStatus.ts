// LegiScan numeric status codes → human labels. Central already sends labels for
// the common codes; a bill whose status arrived as a bare code still reads as a
// word. Anything unmatched passes through unchanged.
const STATUS_LABELS: Record<string, string> = {
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
