#!/usr/bin/env node
// Rebuild the TABLE OF CONTENTS block in the operator's legal documents from
// their own `## ` headings, so the list can never drift from the sections.
// Anchors use the same slug as renderLegalMarkdown (web/src/lib/legalMarkdown.ts).
// Usage: node scripts/legal-toc.mjs [file...]   (defaults to docs/legal/*.md)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const slug = (s) =>
  s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-')

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync('docs/legal')
      .filter((f) => f.endsWith('.md') && !f.endsWith('.example.md'))
      .map((f) => join('docs/legal', f))

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.trim() === '## TABLE OF CONTENTS')
  if (start === -1) {
    console.log(`${file}: no TABLE OF CONTENTS heading — skipped`)
    continue
  }
  const after = lines.slice(start + 1)
  const end = after.findIndex((l) => l.startsWith('## '))
  if (end === -1) {
    console.log(`${file}: no sections after the TOC — skipped`)
    continue
  }
  const headings = after.slice(end).filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim())
  const toc = headings.map((h) => `- [${h}](#${slug(h)})`)
  const out = [...lines.slice(0, start + 1), '', ...toc, '', ...after.slice(end)]
  writeFileSync(file, out.join('\n').replace(/\n{3,}/g, '\n\n'))
  console.log(`${file}: ${headings.length} sections`)
}
