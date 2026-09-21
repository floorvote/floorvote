import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemberNameCell } from './MemberNameCell'

describe('MemberNameCell', () => {
  it('renders name, subtitle, and a mailto link in that order', () => {
    const { container } = render(
      <MemberNameCell name="Ada Lovelace" email="ada@example.com" subtitle="Analytical Engine" />,
    )
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Analytical Engine')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'ada@example.com' })
    expect(link).toHaveAttribute('href', 'mailto:ada@example.com')
    const text = container.textContent ?? ''
    expect(text.indexOf('Ada Lovelace')).toBeLessThan(text.indexOf('Analytical Engine'))
    expect(text.indexOf('Analytical Engine')).toBeLessThan(text.indexOf('ada@example.com'))
  })

  it('omits the subtitle when there is none', () => {
    render(<MemberNameCell name="Ada Lovelace" email="ada@example.com" subtitle={null} />)
    expect(screen.getByRole('link', { name: 'ada@example.com' })).toBeInTheDocument()
  })

  it('shows the ME badge only when isSelf', () => {
    const { rerender } = render(<MemberNameCell name="Ada Lovelace" email="ada@example.com" />)
    expect(screen.queryByText('ME')).not.toBeInTheDocument()
    rerender(<MemberNameCell name="Ada Lovelace" email="ada@example.com" isSelf />)
    expect(screen.getByText('ME')).toBeInTheDocument()
  })

  it('renders the email as a blue-link on every surface', () => {
    render(<MemberNameCell name="Ada Lovelace" email="ada@example.com" />)
    const link = screen.getByRole('link', { name: 'ada@example.com' })
    // One style, no variant prop: the admin table and the popup render the
    // same cell, which is the whole point of sharing it.
    expect(link).toHaveClass('blue-link')
    expect(link.style.display).toBe('block')
    // Hover underline comes from .blue-link:hover in CSS, not inline handlers.
    expect(link.style.textDecoration).toBe('')
  })

  it('breaks the email, not the name, when the column is narrow', () => {
    render(<MemberNameCell name="Ada Lovelace" email="ada@example.com" />)
    expect(screen.getByRole('link', { name: 'ada@example.com' }).style.wordBreak).toBe('break-all')
    expect(screen.getByText('Ada Lovelace').style.wordBreak).toBe('')
  })
})
