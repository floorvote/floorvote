// web/src/lib/libStyleValues.test.ts
import { describe, it, expect } from 'vitest'
import { CHIP_BASE, CHIP_MINI, COUNT_BADGE } from './chipStyles'
import { CARD } from './cardStyle'
import { SECTION_LABEL, CHROME_TEXT } from './textStyles'

// Locks the resolved appearance of shared helpers. After the token refactor,
// values tokenized exactly must remain identical; values that were part of an
// APPROVED consolidation get updated here with a comment citing
// docs/style-token-decisions.md.
describe('lib helper resolved values', () => {
  it('CHIP_BASE', () => {
    expect(CHIP_BASE).toMatchObject({
      fontSize: 12, fontWeight: 600, padding: '3px 10px',
      borderRadius: 4, border: '1px solid transparent', background: '#ecf0f6', color: '#5e697d', // textSecondary darkened for WCAG AA (2026-06-24)
    })
  })
  it('CHIP_MINI', () => {
    expect(CHIP_MINI).toMatchObject({ fontSize: 10, padding: '2px 6px', borderRadius: 4 }) // consolidated per docs/style-token-decisions.md
  })
  it('CARD', () => {
    expect(CARD).toMatchObject({ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 })
  })
  it('COUNT_BADGE', () => {
    expect(COUNT_BADGE).toMatchObject({ fontSize: 10, color: '#616e82', background: '#ecf0f6', borderRadius: 8 }) // textMuted/count-chip fill darkened to AA floor (2026-06-26)
  })
  it('SECTION_LABEL', () => {
    expect(SECTION_LABEL).toMatchObject({ fontSize: 12, fontWeight: 600, color: '#667386', letterSpacing: '0.06em', textTransform: 'uppercase' }) // textMuted darkened for WCAG AA (2026-06-24)
  })
  it('CHROME_TEXT', () => {
    expect(CHROME_TEXT).toMatchObject({ fontSize: 10, color: '#667386' }) // textMuted darkened for WCAG AA (2026-06-24)
  })
})
