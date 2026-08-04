import { describe, it, expect } from 'vitest'
import { LOGO_MARK, LOGO_LOCKUP, logoMarkSvg } from './logo'

describe('LOGO_MARK', () => {
  it('has three row paths and the canonical viewBoxes', () => {
    expect(LOGO_MARK.paths).toHaveLength(3)
    expect(LOGO_MARK.viewBox).toBe('20 25.6 60 42')
    expect(LOGO_MARK.inlineViewBox).toBe('21.2 26.832 57.6 37.938')
  })
})

describe('LOGO_LOCKUP', () => {
  it('carries the locked v1.1 metrics and weight 600', () => {
    expect(LOGO_LOCKUP.markHeightEm).toBe(0.698)
    expect(LOGO_LOCKUP.gapEm).toBe(0.343)
    expect(LOGO_LOCKUP.weight).toBe(600)
  })
})

describe('logoMarkSvg', () => {
  it('renders a standalone filled honey svg with three paths', () => {
    const svg = logoMarkSvg()
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('fill="#e8a33d"')
    expect(svg).not.toContain('stroke')
    expect((svg.match(/<path/g) ?? []).length).toBe(3)
  })
  it('accepts a custom fill color', () => {
    expect(logoMarkSvg('#1e3a5f')).toContain('fill="#1e3a5f"')
  })
})
