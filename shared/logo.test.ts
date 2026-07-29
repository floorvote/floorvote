import { describe, it, expect } from 'vitest'
import { LOGO_MARK, LOGO_LOCKUP, logoMarkSvg } from './logo'

describe('LOGO_MARK', () => {
  it('has three row paths and the canonical viewBox / stroke', () => {
    expect(LOGO_MARK.paths).toHaveLength(3)
    expect(LOGO_MARK.viewBox).toBe('20 25.6 60 42')
    expect(LOGO_MARK.strokeWidth).toBe(4.8)
  })
})

describe('LOGO_LOCKUP', () => {
  it('carries the locked metrics and weight 600', () => {
    expect(LOGO_LOCKUP.markHeightEm).toBe(0.83)
    expect(LOGO_LOCKUP.gapEm).toBe(0.29)
    expect(LOGO_LOCKUP.markShiftY).toBe('-2.5%')
    expect(LOGO_LOCKUP.weight).toBe(600)
  })
})

describe('logoMarkSvg', () => {
  it('renders a standalone honey svg with three paths', () => {
    const svg = logoMarkSvg()
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('#e8a33d')
    expect((svg.match(/<path/g) ?? []).length).toBe(3)
  })
  it('accepts a custom stroke color', () => {
    expect(logoMarkSvg('#1e3a5f')).toContain('#1e3a5f')
  })
})
