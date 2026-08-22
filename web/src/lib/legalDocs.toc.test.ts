import { describe, it, expect } from 'vitest'
import { legalDocs } from './legalDocs'
import { headingSlug } from './legalMarkdown'

/**
 * Each legal document carries its own TABLE OF CONTENTS. Word's hand-maintained
 * version went stale (it listed sections that had been folded away), so the rule
 * here is structural: the TOC lists every `## ` heading that follows it, in order,
 * linked by the same slug renderLegalMarkdown puts on the heading.
 *
 * Content is environment-dependent — the real docs are gitignored and absent in
 * CI — so each doc is only checked when it is present. Run
 * `node scripts/legal-toc.mjs` to rebuild a TOC after editing headings.
 */
function tocEntries(md: string) {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trim() === '## TABLE OF CONTENTS')
  if (start === -1) return null
  const after = lines.slice(start + 1)
  const end = after.findIndex((l) => l.startsWith('## '))
  const block = end === -1 ? after : after.slice(0, end)
  const entries = block
    .map((l) => /^- \[(.+)\]\(#(.+)\)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ label: m[1], slug: m[2] }))
  const headings = (end === -1 ? [] : after.slice(end))
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim())
  return { entries, headings }
}

describe.each([
  ['terms', legalDocs.terms],
  ['privacy', legalDocs.privacy],
])('%s table of contents', (_name, md) => {
  it('lists every section heading, in order, with resolvable anchors', () => {
    if (md === null) return // absent in CI; nothing to check
    const parsed = tocEntries(md)
    expect(parsed).not.toBeNull()
    const { entries, headings } = parsed!
    expect(entries.map((e) => e.label)).toEqual(headings)
    for (const e of entries) expect(e.slug).toBe(headingSlug(e.label))
  })
})
