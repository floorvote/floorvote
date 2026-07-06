import { describe, it, expect } from 'vitest'
import { TOOLTIP_CHROME, TOOLTIP_STYLE } from './chipStyles'
import { color, radius, shadow } from '../styles/tokens'

describe('TOOLTIP_CHROME', () => {
  it('carries the shared white-bubble chrome from tokens', () => {
    expect(TOOLTIP_CHROME).toEqual({
      background: color.white,
      border: `1px solid ${color.borderDefault}`,
      boxShadow: shadow.md,
      borderRadius: radius.sm,
    })
  })

  it('TOOLTIP_STYLE builds on the chrome and adds the single-line text bits', () => {
    expect(TOOLTIP_STYLE.background).toBe(color.white)
    expect(TOOLTIP_STYLE.boxShadow).toBe(shadow.md)
    expect(TOOLTIP_STYLE.borderRadius).toBe(radius.sm)
    expect(TOOLTIP_STYLE.whiteSpace).toBe('nowrap')
    expect(TOOLTIP_STYLE.zIndex).toBe(9000)
    expect(TOOLTIP_STYLE.pointerEvents).toBe('none')
  })
})
