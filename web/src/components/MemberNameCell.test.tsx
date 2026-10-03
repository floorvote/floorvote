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

  describe('with no name (never set, or cleared)', () => {
    it('shows the email in the name\'s place, as the mailto link', () => {
      const { container } = render(<MemberNameCell name="" email="cleared@example.com" subtitle="Analyst" />)
      const links = screen.getAllByRole('link')
      expect(links).toHaveLength(1)
      expect(links[0]).toHaveTextContent('cleared@example.com')
      expect(links[0]).toHaveAttribute('href', 'mailto:cleared@example.com')
      // The email leads, and isn't repeated under the subtitle.
      const text = container.textContent ?? ''
      expect(text.indexOf('cleared@example.com')).toBeLessThan(text.indexOf('Analyst'))
      expect(text.split('cleared@example.com')).toHaveLength(2)
    })

    it('keeps the email breakable and the ME badge beside it', () => {
      render(<MemberNameCell name="" email="cleared@example.com" isSelf />)
      const link = screen.getByRole('link', { name: 'cleared@example.com' })
      expect(link.style.wordBreak).toBe('break-all')
      expect(link.parentElement).toContainElement(screen.getByText('ME'))
    })

    it('renders no empty name element', () => {
      const { container } = render(<MemberNameCell name="" email="cleared@example.com" />)
      const spans = [...container.querySelectorAll('span')]
      expect(spans.every(s => (s.textContent ?? '').trim() !== '')).toBe(true)
    })
  })
})
