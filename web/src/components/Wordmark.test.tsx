import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Wordmark } from './Wordmark'
import { color } from '../styles/tokens'

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

  it('renders Floor in navy on light surfaces by default', () => {
    render(<Wordmark />)
    expect(screen.getByText('Floor')).toHaveStyle({ color: color.billBadgeNavy })
  })

  it('renders Floor in white on dark surfaces', () => {
    render(<Wordmark dark />)
    expect(screen.getByText('Floor')).toHaveStyle({ color: color.white })
  })
})
