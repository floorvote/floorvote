import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { color } from '../../styles/tokens'
import { DateDivider, isDividerStuck } from './DateDivider'

describe('DateDivider', () => {
  it('renders the label', () => {
    render(<DateDivider label="THU, JUN 2" />)
    expect(screen.getByText('THU, JUN 2')).toBeInTheDocument()
  })
  it('uses amber for the label when isToday', () => {
    render(<DateDivider label="TODAY" isToday />)
    expect(screen.getByText('TODAY')).toHaveStyle({ color: color.accentAmber })
  })
  it('uses muted color when not today', () => {
    render(<DateDivider label="THU, JUN 2" />)
    expect(screen.getByText('THU, JUN 2')).toHaveStyle({ color: color.textMuted })
  })
})

describe('isDividerStuck', () => {
  // lineY is the viewport y of the sticky line; the divider's day wrapper rect
  // is { top, bottom }; dividerHeight is the divider's own height.
  const H = 33

  it('is not stuck at rest (wrapper still below the line)', () => {
    expect(isDividerStuck({ top: 120, bottom: 800 }, 0, H)).toBe(false)
  })

  it('is stuck while pinned (wrapper top at/above the line, bottom far below)', () => {
    expect(isDividerStuck({ top: -50, bottom: 800 }, 0, H)).toBe(true)
  })

  it('is stuck exactly when the wrapper top reaches the line', () => {
    expect(isDividerStuck({ top: 0, bottom: 800 }, 0, H)).toBe(true)
  })

  it('is NOT stuck once the wrapper bottom reaches the push point', () => {
    // bottom (30) <= line(0) + H(33) + PUSH_LEAD(0) = 33  -> being pushed
    expect(isDividerStuck({ top: -400, bottom: 30 }, 0, H)).toBe(false)
    // still stuck while the section bottom is comfortably below the push point
    expect(isDividerStuck({ top: -400, bottom: 200 }, 0, H)).toBe(true)
  })

  it('respects a non-zero sticky line (agenda header offset baked into lineY)', () => {
    // wrapper top 50 is below a line at 40 -> not pinned yet
    expect(isDividerStuck({ top: 50, bottom: 800 }, 40, H)).toBe(false)
    // wrapper top 40 reaches the line -> pinned
    expect(isDividerStuck({ top: 40, bottom: 800 }, 40, H)).toBe(true)
  })
})

describe('DateDivider sticky styles', () => {
  it('renders sticky and pins 1px under the given offset (seam overlap)', () => {
    render(<DateDivider label="THU, JUN 2" stickyTop={40} />)
    const divider = screen.getByText('THU, JUN 2').parentElement as HTMLElement
    expect(divider).toHaveStyle({ position: 'sticky', top: '39px' })
  })

  it('is sticky by default when no stickyTop is given', () => {
    render(<DateDivider label="THU, JUN 2" />)
    const divider = screen.getByText('THU, JUN 2').parentElement as HTMLElement
    expect(divider).toHaveStyle({ position: 'sticky' })
  })

  it('renders the pinned shadow on a separate aria-hidden strip, hidden at rest', () => {
    render(<DateDivider label="THU, JUN 2" />)
    const divider = screen.getByText('THU, JUN 2').parentElement as HTMLElement
    const strip = divider.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(strip).toBeTruthy()
    // jsdom has no scroll container, so the divider never pins -> strip stays hidden
    expect(strip).toHaveStyle({ opacity: '0' })
    // the shadow is a gradient on the strip, not a box-shadow on the divider element
    expect(divider.style.boxShadow).toBe('')
    expect(strip.getAttribute('style')).toContain('linear-gradient')
  })
})
