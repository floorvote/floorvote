import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NewMatchChip } from './NewMatchChip'
import { color } from '../styles/tokens'

describe('NewMatchChip (the amber new-match state, read-only, for members)', () => {
  it('reads "New match"', () => {
    render(<NewMatchChip />)
    expect(screen.getByText('New match')).toBeInTheDocument()
  })

  it('is amber, matching the priority dropdown in its new-match state', () => {
    render(<NewMatchChip />)
    expect(screen.getByText('New match')).toHaveStyle({
      background: color.bgAmberPriority, color: color.textAmberDark, border: `1px solid ${color.borderAmber}`,
    })
  })

  it('offers no action: no combobox, no button, no link', () => {
    render(<NewMatchChip />)
    expect(screen.getByText('New match')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('is not focusable', () => {
    render(<NewMatchChip />)
    expect(screen.getByText('New match')).not.toHaveAttribute('tabindex')
  })
})
