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
})
