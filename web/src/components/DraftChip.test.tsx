import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TitleDraftMarker } from './DraftChip'
import { BODY_FONT } from '../styles/tokens'

// ---------------------------------------------------------------------------
// Regression: "Draft" rendered TWICE at full width.
//
// TitleDraftMarker used to set `display: 'inline-flex'` in its inline style
// object. mobile.css's base rule is `.bill-title-draft-marker { display: none }`
// with no !important, and an inline style outranks any non-!important
// stylesheet declaration — so the marker was never actually hidden and drew on
// the title line at EVERY width, alongside the Status-column DraftChip.
//
// The existing mobileDraftChip.test.ts could not catch this: it asserts the
// hide rule exists *as text in the stylesheet*, which it always did. The rule
// was present and losing the cascade. These two tests assert the other side of
// that contract — that the component leaves `display` to the stylesheet — and
// both fail against the pre-fix component.
// ---------------------------------------------------------------------------
describe('TitleDraftMarker — the stylesheet, not the component, owns visibility', () => {
  it('sets no inline display, so mobile.css’s base hide is not overridden', () => {
    render(<TitleDraftMarker className="bill-title-draft-marker" />)
    const el = screen.getByText('Draft')
    // Empty string = the property is simply not in the inline style attribute.
    // Any value here (even 'none') means the component is fighting the
    // stylesheet and the @container/@media breakpoints stop deciding.
    expect(el.style.display).toBe('')
    expect(el.getAttribute('style') ?? '').not.toMatch(/(^|;)\s*display\s*:/)
  })

  // Source-level twin of the above. The render test proves the DOM is clean;
  // this one names the mistake so a future edit that re-adds the property is
  // rejected with an explanation rather than a bare assertion failure.
  it('does not name `display` in its style object in the source', () => {
    const source = readFileSync(join(__dirname, 'DraftChip.tsx'), 'utf8')
    const fn = source.slice(source.indexOf('export function TitleDraftMarker'))
    expect(fn).not.toMatch(/^\s*display:/m)
  })

  // Bug 2: the marker sits inside the bill title div, which sets
  // 'Source Serif 4', serif. Without an explicit family it inherited the
  // serif and the word "Draft" rendered in a different face from every other
  // chip in the row.
  it('opts back out of the title’s serif to the body/UI font token', () => {
    render(<TitleDraftMarker className="bill-title-draft-marker" />)
    const el = screen.getByText('Draft')
    expect(el.style.fontFamily).not.toBe('')
    // Not the title's face: no 'Source Serif 4', and the generic fallback is
    // sans-serif rather than a bare `serif` at the end of the stack.
    expect(el.style.fontFamily).not.toMatch(/Source Serif/i)
    expect(el.style.fontFamily).not.toMatch(/(^|,\s*)["']?serif["']?\s*$/)
    expect(el.style.fontFamily).toMatch(/sans-serif\s*$/)
    // Compare against the token, not a restated literal, so the two can't drift.
    expect(el.style.fontFamily.replace(/["']/g, '')).toBe(BODY_FONT.replace(/["']/g, ''))
  })
})
