import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards the pairing described in mobile.css: every @container block that
// hides .bill-col-status (the Status column, where the "Draft" marker
// normally lives at zero extra width) must also show .bill-draft-chip-inline
// in the SAME block — the inline fallback copy of the marker next to the bill
// badge. Those hide/show rules use container-query breakpoints, which don't
// line up with the max-width: 768px *viewport* media query that swaps in
// .bill-row-mobile-meta — a narrow sidebar can shrink the row's container well
// before the viewport itself goes mobile — so without a same-block inline
// fallback, "Draft" silently vanishes in that band and only the dashed badge
// survives. If someone adds/removes/renumbers a .bill-col-status breakpoint
// without updating its .bill-draft-chip-inline pair, this test catches it.
const css = readFileSync(join(__dirname, 'mobile.css'), 'utf8')

// Split into top-level @container blocks (this file has no nested ones).
function containerBlocks(source: string): string[] {
  const blocks: string[] = []
  const re = /@container[^{]*\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) {
    const start = match.index
    let depth = 1
    let i = re.lastIndex
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      i++
    }
    blocks.push(source.slice(start, i))
  }
  return blocks
}

describe('mobile.css — Draft marker inline-fallback pairing', () => {
  const blocks = containerBlocks(css)

  it('finds at least one @container block hiding .bill-col-status (sanity check the parser)', () => {
    const statusHidingBlocks = blocks.filter(b => /\.bill-col-status\b[^}]*display:\s*none\s*!important/.test(b))
    expect(statusHidingBlocks.length).toBeGreaterThanOrEqual(8) // 4 single-state + 4 .bill-list-ms
  })

  it('every block that hides .bill-col-status also shows .bill-draft-chip-inline in the same block', () => {
    const offenders: string[] = []
    for (const block of blocks) {
      const hidesStatus = /\.bill-col-status\b[^}]*display:\s*none\s*!important/.test(block)
      if (!hidesStatus) continue
      const showsInlineChip = /\.bill-draft-chip-inline\s*\{[^}]*display:\s*inline-flex\s*!important/.test(block)
      if (!showsInlineChip) {
        const header = block.slice(0, block.indexOf('{')).trim()
        offenders.push(header)
      }
    }
    expect(offenders).toEqual([])
  })

  it('a multi-state (.bill-list-ms) status-hiding block shows the .bill-list-ms-scoped inline chip, not the unscoped one', () => {
    const msBlocks = blocks.filter(b => /\.bill-list-ms \.bill-col-status\b[^}]*display:\s*none\s*!important/.test(b))
    expect(msBlocks.length).toBeGreaterThanOrEqual(4)
    for (const block of msBlocks) {
      expect(/\.bill-list-ms \.bill-draft-chip-inline\s*\{[^}]*display:\s*inline-flex\s*!important/.test(block)).toBe(true)
    }
  })
})
