import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Wordmark } from './Wordmark'
import { color } from '../styles/tokens'
import { resolveColor } from '../test/colorTokens'

describe('Wordmark', () => {
  it('renders Floor and Vote', () => {
    render(<Wordmark />)
    expect(screen.getByText('Floor')).toBeInTheDocument()
    expect(screen.getByText('Vote')).toBeInTheDocument()
  })

  it('renders the Vote part in the logo orange', () => {
    render(<Wordmark />)
    expect(screen.getByText('Vote')).toHaveStyle({ color: color.accentAmber })
  })

  it('renders Floor in the wordmark color on the page by default', () => {
    render(<Wordmark />)
    expect(screen.getByText('Floor')).toHaveStyle({ color: color.wordmarkFloor })
  })

  it('renders Floor in white on dark surfaces', () => {
    render(<Wordmark dark />)
    expect(screen.getByText('Floor')).toHaveStyle({ color: color.textOnBrand })
  })

  it('renders the hemicycle mark to the left of the text', () => {
    render(<Wordmark />)
    expect(screen.getByRole('img', { name: 'FloorVote' })).toBeInTheDocument()
  })

  // The brand lockup is navy "Floor" + Honey "Vote" on light surfaces and white
  // "Floor" + Honey "Vote" on dark ones. In dark mode the page itself is dark, so
  // the default lockup takes the on-dark treatment; navy would be 1.4:1 there.
  // Honey and the mark never change with the mode.
  it('renders Floor in brand navy in light mode and in white in dark mode', () => {
    render(<Wordmark />)
    const floor = screen.getByText('Floor').style.color
    expect(resolveColor(floor, 'light')).toBe('#1e3a5f')
    expect(resolveColor(floor, 'dark')).toBe('#fff')
  })

  it('keeps Vote and the mark in Honey in both modes', () => {
    render(<Wordmark />)
    const vote = screen.getByText('Vote').style.color
    const mark = screen.getByRole('img', { name: 'FloorVote' }).style.fill
    for (const mode of ['light', 'dark'] as const) {
      expect(resolveColor(vote, mode), mode).toBe('#e8a33d')
      expect(resolveColor(mark, mode), mode).toBe('#e8a33d')
    }
  })
})
