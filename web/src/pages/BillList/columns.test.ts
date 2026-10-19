import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUTER_GRID, POSITION_COL_WIDTH, PRIORITY_COL_WIDTH, ROW_PADDING_LEFT, ROW_PADDING_RIGHT } from './constants'

// The Bills table's outer columns (the title column, Position, Priority) and the
// padding the header and every row share. The amber "New · Set priority" control
// is the widest thing the priority column holds, and the row's right padding
// sits outside the column, so the control has to fit the track itself.

const NEW_MATCH_CONTROL_WIDTH = 135
const css = readFileSync(join(__dirname, '../../styles/mobile.css'), 'utf8')

describe('the Bills table outer columns', () => {
  it('gives Priority 140px and keeps Position at 170px', () => {
    expect(PRIORITY_COL_WIDTH).toBe(140)
    expect(POSITION_COL_WIDTH).toBe(170)
    expect(OUTER_GRID).toBe('minmax(0,1fr) 170px 140px')
  })

  it('is wide enough for the amber New · Set priority control, with the padding outside the track', () => {
    expect(PRIORITY_COL_WIDTH).toBeGreaterThanOrEqual(NEW_MATCH_CONTROL_WIDTH)
  })

  it('pads a row 8px on the left and 28px on the right', () => {
    expect(ROW_PADDING_LEFT).toBe(8)
    expect(ROW_PADDING_RIGHT).toBe(28)
  })
})

describe('the narrow-width column rules in mobile.css', () => {
  // The two blocks that drop Position keep Priority at its full width so the dropdown isn't clipped.
  const narrowGrids = css.match(/grid-template-columns:\s*12px minmax\(0,\s*1fr\)\s*\d+px\s*!important/g) ?? []

  it('keeps Priority at the column width, in both the single-state and multi-state block', () => {
    expect(narrowGrids).toHaveLength(2)
    for (const rule of narrowGrids) expect(rule).toContain(`${PRIORITY_COL_WIDTH}px`)
  })

  it('names no other Priority width', () => {
    expect(css).not.toMatch(/12px minmax\(0,\s*1fr\)\s*120px/)
  })
})
