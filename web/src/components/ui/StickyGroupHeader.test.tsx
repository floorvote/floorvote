import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StickyGroupHeader } from './StickyGroupHeader'

describe('StickyGroupHeader', () => {
  it('renders the label', () => {
    render(<StickyGroupHeader label="UT" height={24} stuck pushOffset={0} />)
    expect(screen.getByText('UT')).toBeInTheDocument()
  })

  // Regression guard for the "option row bleeds through above the pinned
  // header" staging bug: the header's background must be a real opaque color,
  // not transparent — asserted on resolved computed style, not className,
  // since a transparent background would still pass a shallow className check.
  it('has a non-transparent background so rows scrolling underneath are masked', () => {
    render(<StickyGroupHeader label="AZ" height={24} stuck pushOffset={0} />)
    const header = screen.getByText('AZ').closest('div') as HTMLElement
    const bg = getComputedStyle(header).backgroundColor
    expect(bg).not.toBe('')
    expect(bg).not.toBe('transparent')
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('carries a bottom rule for separation from the rows below', () => {
    render(<StickyGroupHeader label="AZ" height={24} stuck pushOffset={0} />)
    const header = screen.getByText('AZ').closest('div') as HTMLElement
    expect(getComputedStyle(header).borderBottomWidth).not.toBe('0px')
  })
})
