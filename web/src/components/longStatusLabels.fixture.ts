// The longest status label in each provider's vocabulary (central/src/providers/*/vocabulary.ts),
// plus a bare LegiScan code the web app decodes to its label. Tests use these to check that the
// worst case in each vocabulary is capped and still readable in full. LegiScan's labels are all
// short, so its longest is the widest decoded word.
export const LONGEST_STATUS_LABELS: { provider: string; status: string; label: string }[] = [
  { provider: 'legiscan', status: '10', label: 'Report Pass' },
  { provider: 'lims', status: 'Under Congressional Review', label: 'Under Congressional Review' },
  { provider: 'mga', status: "Enacted without the Governor's signature", label: "Enacted without the Governor's signature" },
  { provider: 'lis', status: 'Continued from last session', label: 'Continued from last session' },
]

// Longer than any real label, for the cap itself.
export const VERY_LONG_STATUS = 'Referred to the Committee on Rules and Executive Nominations for Further Study'
