import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { IosToggle } from './IosToggle'

describe('IosToggle', () => {
  it('reflects checked state and fires onChange', () => {
    const onChange = vi.fn()
    render(<IosToggle checked={false} disabled={false} busy={false} onChange={onChange} ariaLabel="Toggle X" />)
    const sw = screen.getByRole('switch', { name: 'Toggle X' })
    expect(sw).not.toBeChecked()
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })
  it('does not fire when busy or disabled', () => {
    const onChange = vi.fn()
    render(<IosToggle checked={false} disabled busy={false} onChange={onChange} ariaLabel="Toggle Y" />)
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Y' }))
    expect(onChange).not.toHaveBeenCalled()
  })
  it('stays focusable while busy, so a keyboard user keeps their place, and still ignores changes', () => {
    const onChange = vi.fn()
    render(<IosToggle checked={false} disabled={false} busy onChange={onChange} ariaLabel="Toggle Z" />)
    const sw = screen.getByRole('switch', { name: 'Toggle Z' })
    expect(sw).not.toBeDisabled()
    expect(sw).toHaveAttribute('aria-disabled', 'true')
    sw.focus()
    expect(document.activeElement).toBe(sw)
    fireEvent.click(sw)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('is natively disabled when permanently disabled', () => {
    render(<IosToggle checked={false} disabled busy={false} onChange={vi.fn()} ariaLabel="Toggle W" />)
    expect(screen.getByRole('switch', { name: 'Toggle W' })).toBeDisabled()
  })
})
