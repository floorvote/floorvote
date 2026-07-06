import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PinnedShadow } from './PinnedShadow'

describe('PinnedShadow', () => {
  it('renders an aria-hidden gradient bar, hidden when not visible', () => {
    const { container } = render(<PinnedShadow visible={false} />)
    const bar = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(bar).toBeTruthy()
    expect(bar).toHaveStyle({ opacity: '0' })
    expect(bar.getAttribute('style')).toContain('linear-gradient')
  })

  it('is opaque when visible', () => {
    const { container } = render(<PinnedShadow visible />)
    const bar = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(bar).toHaveStyle({ opacity: '1' })
  })
})
