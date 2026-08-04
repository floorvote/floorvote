import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LogoMark } from './LogoMark'
import { LOGO_MARK } from '../../../shared/logo'
import { color } from '../styles/tokens'

describe('LogoMark', () => {
  it('renders an accessible svg with the three row paths', () => {
    const { container } = render(<LogoMark />)
    const svg = screen.getByRole('img', { name: 'FloorVote' })
    expect(svg).toBeInTheDocument()
    expect(svg.getAttribute('viewBox')).toBe(LOGO_MARK.viewBox)
    expect(container.querySelectorAll('path')).toHaveLength(3)
  })

  it('fills in Honey by default', () => {
    render(<LogoMark />)
    expect(screen.getByRole('img', { name: 'FloorVote' })).toHaveAttribute('fill', color.accentAmber)
  })

  it('accepts a custom fill', () => {
    render(<LogoMark fill="#1e3a5f" />)
    expect(screen.getByRole('img', { name: 'FloorVote' })).toHaveAttribute('fill', '#1e3a5f')
  })

  it('uses the tight inline viewBox when inline', () => {
    render(<LogoMark inline />)
    expect(screen.getByRole('img', { name: 'FloorVote' })).toHaveAttribute('viewBox', LOGO_MARK.inlineViewBox)
  })
})
