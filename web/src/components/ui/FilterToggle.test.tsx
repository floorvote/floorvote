import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilterToggle } from './FilterToggle'

describe('FilterToggle', () => {
  it('renders the label and fires onToggle on click', () => {
    const onToggle = vi.fn()
    render(<FilterToggle label="My bills" active={false} onToggle={onToggle} />)
    const button = screen.getByRole('button', { name: 'My bills' })
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('shows a count badge only when count is provided', () => {
    const { rerender } = render(<FilterToggle label="My bills" active={false} onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: 'My bills' })).toBeInTheDocument()
    expect(screen.queryByText('42')).not.toBeInTheDocument()

    rerender(<FilterToggle label="My bills" active={false} onToggle={() => {}} count={42} />)
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('appends a checkmark only when showCheck and active are both true', () => {
    const { rerender } = render(<FilterToggle label="Sponsor Support" active={false} onToggle={() => {}} showCheck />)
    expect(screen.getByRole('button', { name: 'Sponsor Support' })).toBeInTheDocument()

    rerender(<FilterToggle label="Sponsor Support" active onToggle={() => {}} showCheck />)
    expect(screen.getByRole('button', { name: 'Sponsor Support ✓' })).toBeInTheDocument()
  })

  it('does not append a checkmark when active but showCheck is not set', () => {
    render(<FilterToggle label="My bills" active onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: 'My bills' })).toBeInTheDocument()
  })

  it('exposes on/off state via aria-pressed, not color alone', () => {
    const { rerender } = render(<FilterToggle label="My bills" active={false} onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: 'My bills' })).toHaveAttribute('aria-pressed', 'false')

    rerender(<FilterToggle label="My bills" active onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: 'My bills' })).toHaveAttribute('aria-pressed', 'true')
  })
})
