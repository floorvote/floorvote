import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards the pairing described in mobile.css: every @container block that
// hides .bill-col-status (the Status column, where the "Draft" marker
// normally lives at zero extra width) must also show .bill-title-draft-marker
// in the SAME block — the mid-width fallback copy of the marker on the bill
// title line. Those hide/show rules use container-query breakpoints, which
// don't line up with the max-width: 768px *viewport* media query that swaps
// in .bill-row-mobile-meta — a narrow sidebar can shrink the row's container
// well before the viewport itself goes mobile — so without a same-block
// title-line fallback, "Draft" silently vanishes in that band and only the
// dashed badge survives. If someone adds/removes/renumbers a
// .bill-col-status breakpoint without updating its .bill-title-draft-marker
// pair, this test catches it.
//
// An earlier version of this fallback lived in the chip-grid row instead
// (.bill-draft-chip-inline) and widened a per-row grid track to fit it —
// that broke column alignment (Year/Last action/Relevance sat 60px right of
// every other row) and was reverted. The title line is the flexible
// `minmax(0, 1fr)` column, identical for every row, so this version needs no
// track-width mechanism at all.
const css = readFileSync(join(__dirname, 'mobile.css'), 'utf8')
const billRowSource = readFileSync(join(__dirname, '../pages/BillList/BillRow.tsx'), 'utf8')

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

// Strip every top-level @container/@media/@supports block, leaving only rules
// that apply unconditionally (used to find the *default* .bill-title-draft-marker
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

describe('mobile.css — Draft marker mid-width-fallback pairing', () => {
  const blocks = containerBlocks(css)

  it('finds at least one @container block hiding .bill-col-status (sanity check the parser)', () => {
    const statusHidingBlocks = blocks.filter(b => /\.bill-col-status\b[^}]*display:\s*none\s*!important/.test(b))
    expect(statusHidingBlocks.length).toBeGreaterThanOrEqual(8) // 4 single-state + 4 .bill-list-ms
  })

  it('every block that hides .bill-col-status also shows .bill-title-draft-marker in the same block', () => {
    const offenders: string[] = []
    for (const block of blocks) {
      const hidesStatus = /\.bill-col-status\b[^}]*display:\s*none\s*!important/.test(block)
      if (!hidesStatus) continue
      const showsMarker = /\.bill-title-draft-marker\s*\{[^}]*display:\s*inline-flex\s*;/.test(block)
      if (!showsMarker) {
        const header = block.slice(0, block.indexOf('{')).trim()
        offenders.push(header)
      }
    }
    expect(offenders).toEqual([])
  })

  it('a multi-state (.bill-list-ms) status-hiding block shows the .bill-list-ms-scoped marker, not the unscoped one', () => {
    const msBlocks = blocks.filter(b => /\.bill-list-ms \.bill-col-status\b[^}]*display:\s*none\s*!important/.test(b))
    expect(msBlocks.length).toBeGreaterThanOrEqual(4)
    for (const block of msBlocks) {
      expect(/\.bill-list-ms \.bill-title-draft-marker\s*\{[^}]*display:\s*inline-flex\s*;/.test(block)).toBe(true)
    }
  })

  // Deleting the base "display: none" rule would leave every "reveal"
  // assertion above green while the marker showed at every width, doubling
  // up with the Status-column DraftChip everywhere.
  it('has a default (outside any @container/@media/@supports block) rule hiding .bill-title-draft-marker', () => {
    const unconditional = stripAtRuleBlocks(css)
    expect(/\.bill-title-draft-marker\s*\{[^}]*display:\s*none\s*;/.test(unconditional)).toBe(true)
  })

  // Nothing above ties the CSS class to the component that renders it.
  // Renaming bill-title-draft-marker in BillRow.tsx (or in mobile.css)
  // without updating the other side would leave the whole suite green while
  // permanently hiding — or un-hiding — the fallback marker.
  it('the className BillRow.tsx renders on the title-line marker matches the class mobile.css targets', () => {
    const rendered = /<TitleDraftMarker\s+className="([\w-]+)"\s*\/>/.exec(billRowSource)
    expect(rendered).not.toBeNull()
    const className = rendered![1]
    expect(className).toBe('bill-title-draft-marker')
    // And the stylesheet actually has a selector for that exact class (not just
    // a substring match against some unrelated rule).
    expect(new RegExp(`\\.${className}\\b`).test(css)).toBe(true)
  })
})

// Finds a top-level at-rule block by its prelude (brace-matched, so nested
// blocks and comments inside it come along intact). Returns { start, text }.
function atRuleBlock(source: string, prelude: string): { start: number; text: string } | null {
  const start = source.indexOf(prelude)
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 1
  let i = open + 1
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return { start, text: source.slice(start, i) }
}

// The other direction of the same invariant: exactly ONE Draft marker must be
// visible at any width. The @container reveals above turn the title-line
// marker on whenever the Status column is hidden — but the query container is
// the bill-list scroll wrapper (BillList/index.tsx, containerType:
// inline-size), which at ANY phone viewport is always <= 1000px, so those
// reveals are always active on phones. The max-width: 768px block swaps in
// .bill-row-mobile-meta, which renders its own DraftChip. Without an explicit
// re-hide there, a draft row renders "Draft" twice on every phone — visually
// and to screen readers.
describe('mobile.css — Draft marker is hidden on the title line at mobile widths', () => {
  const mobileBlock = atRuleBlock(css, '@media (max-width: 768px)')

  it('finds the mobile viewport block and confirms it reveals the mobile meta row (sanity check)', () => {
    expect(mobileBlock).not.toBeNull()
    expect(/\.bill-row-mobile-meta\s*\{[^}]*display:\s*flex\s*!important/.test(mobileBlock!.text)).toBe(true)
  })

  it('hides .bill-title-draft-marker in the same block that reveals the mobile meta row', () => {
    // The declaration may group both selectors; match a rule whose selector
    // list contains the class and whose body sets display:none. No
    // !important is needed (or used): nothing sets display on this element
    // inline any more, so plain specificity + source order decide.
    const hidesBare = /(^|[,{}])\s*\.bill-title-draft-marker\s*[,{][^}]*display:\s*none\s*;/m.test(
      mobileBlock!.text,
    )
    expect(hidesBare).toBe(true)
  })

  it('also hides the .bill-list-ms-scoped marker, which outranks the bare class', () => {
    // The multi-state reveal is `.bill-list-ms .bill-title-draft-marker`
    // (specificity 0,2,0). A hide written only as `.bill-title-draft-marker`
    // (0,1,0) loses to it on specificity regardless of source order, so
    // both markers would still double up on multi-state lists.
    const hidesMs = /\.bill-list-ms\s+\.bill-title-draft-marker\s*[,{][^}]*display:\s*none\s*;/.test(
      mobileBlock!.text,
    )
    expect(hidesMs).toBe(true)
  })

  it('the mobile block comes after every container-query reveal, so it wins on source order', () => {
    // The bare-class hide and the bare-class reveals have equal specificity
    // (0,1,0), so source order alone decides — this is now the ONLY thing
    // keeping them apart (the rules no longer carry !important, because the
    // component no longer sets display inline for them to fight). If someone
    // moves the mobile block above the reveals, the hide silently stops
    // applying and both markers come back.
    const lastReveal = css.lastIndexOf('.bill-title-draft-marker')
    const revealsBeforeMobile = containerBlocks(css)
      .filter(b => /\.bill-title-draft-marker\s*\{[^}]*display:\s*inline-flex\s*;/.test(b))
      .map(b => css.indexOf(b))
    expect(revealsBeforeMobile.length).toBeGreaterThanOrEqual(8)
    for (const at of revealsBeforeMobile) expect(at).toBeLessThan(mobileBlock!.start)
    expect(lastReveal).toBeGreaterThan(mobileBlock!.start) // the hide itself is the last mention
  })
})
