import { writeFileSync } from 'node:fs'
import { renderSampleEmail } from '../api/src/lib/sampleEmails'

// Local dev server serves web/public (incl. /email-icons/*) so the sample's icon
// images load when opened while `npm run dev` is running. Committed preview = the
// exact same render as the QA send path and the conformance test
// (renderSampleEmail), so they can never drift.
const { html } = renderSampleEmail('week-ahead', 'http://localhost:5173')

const out = process.argv[2] || 'docs/week-ahead-email-sample.html'
writeFileSync(out, html)
console.log(`Wrote ${out} (${html.length} bytes)`)
