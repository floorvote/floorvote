import { writeFileSync } from 'node:fs'
import { renderSampleEmail } from '../api/src/lib/sampleEmails'

// Committed preview = the exact same render as the QA send path and the
// conformance test (renderSampleEmail), so they can never drift.
const frequency = process.argv[3] ?? 'daily'
if (frequency !== 'daily' && frequency !== 'weekly') throw new Error('Digest cadence must be daily or weekly')
const { html } = renderSampleEmail('digest', 'http://localhost:5173', frequency)

const out = process.argv[2] || 'docs/digest-email-sample.html'
writeFileSync(out, html)
console.log(`Wrote ${out} (${html.length} bytes)`)
