import { writeFileSync } from 'node:fs'
import { renderSampleEmail } from '../api/src/lib/sampleEmails'

// Committed preview = the exact same render as the QA send path and the
// conformance test (renderSampleEmail), so they can never drift.
const { html } = renderSampleEmail('digest', 'http://localhost:5173')

const out = process.argv[2] || 'docs/digest-email-sample.html'
writeFileSync(out, html)
console.log(`Wrote ${out} (${html.length} bytes)`)
