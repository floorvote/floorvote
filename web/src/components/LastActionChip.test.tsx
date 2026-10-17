import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { color } from '../styles/tokens'
import { LastActionChip } from './LastActionChip'

describe('LastActionChip', () => {
  it('shows the date', () => {
    render(<LastActionChip date="2026-03-04" />)
    expect(screen.getByText('2026-03-04')).toBeInTheDocument()
  })

  it('shows a dash when there is no last action', () => {
    render(<LastActionChip date={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('is the count-chip fill with secondary text, not clickable', () => {
    render(<LastActionChip date="2026-03-04" />)
    const chip = screen.getByText('2026-03-04')
    expect(chip.style.background).toBe(color.countChipBg)
    expect(chip.style.color).toBe(color.textSecondary)
    expect(chip.tagName).toBe('SPAN')
  })

  it('passes a class through so the Bills page can hide it at narrow widths', () => {
    render(<LastActionChip date="2026-03-04" className="bill-col-lastaction" />)
    expect(screen.getByText('2026-03-04')).toHaveClass('bill-col-lastaction')
  })
})
