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
const billRowSource = readFileSync(join(__dirname, '../pages/BillList/BillRow.tsx'), 'utf8')

// Strip every top-level @container/@media/@supports block, leaving only rules
// that apply unconditionally (used to find the *default* .bill-draft-chip-inline
// rule, as opposed to the reveal rules inside those blocks). Comments are
// stripped first — several of them mention "@container" in prose, which would
// otherwise be mistaken for the start of a real at-rule and swallow real code
// (including the very rule this is trying to find) up to its next literal "{".
function stripAtRuleBlocks(sourceWithComments: string): string {
  const source = sourceWithComments.replace(/\/\*[\s\S]*?\*\//g, '')
  let out = ''
  let i = 0
  while (i < source.length) {
    const atMatch = /@(container|media|supports)[^{]*\{/.exec(source.slice(i))
    if (!atMatch || atMatch.index == null) {
      out += source.slice(i)
      break
    }
    const blockStart = i + atMatch.index
    out += source.slice(i, blockStart)
    let depth = 1
    let j = blockStart + atMatch[0].length
    while (depth > 0 && j < source.length) {
      if (source[j] === '{') depth++
      else if (source[j] === '}') depth--
      j++
    }
    i = j
  }
  return out
}

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

  // Finding B: nothing above proves the chip is hidden OUTSIDE the reveal
  // band. Deleting the base "display: none" rule would leave every "reveal"
  // assertion green while the chip showed at every width, doubling the
  // marker everywhere it isn't needed.
  it('has a default (outside any @container/@media/@supports block) rule hiding .bill-draft-chip-inline', () => {
    const unconditional = stripAtRuleBlocks(css)
    expect(/\.bill-draft-chip-inline\s*\{[^}]*display:\s*none\s*;/.test(unconditional)).toBe(true)
  })

  // Finding C: nothing above ties the CSS class to the component that renders
  // it. Renaming bill-draft-chip-inline in BillRow.tsx (or in mobile.css)
  // without updating the other side would leave the whole suite green while
  // permanently hiding — or un-hiding — the fallback marker.
  it('the className BillRow.tsx renders on the inline DraftChip matches the class mobile.css targets', () => {
    const rendered = /<DraftChip\s+className="([\w-]+)"\s*\/>/.exec(billRowSource)
    expect(rendered).not.toBeNull()
    const className = rendered![1]
    expect(className).toBe('bill-draft-chip-inline')
    // And the stylesheet actually has a selector for that exact class (not just
    // a substring match against some unrelated rule).
    expect(new RegExp(`\\.${className}\\b`).test(css)).toBe(true)
  })
})
