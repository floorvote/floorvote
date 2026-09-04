import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { SaveViewButton } from './SaveViewButton'

describe('SaveViewButton', () => {
  it('opens a popover naming what will be captured', () => {
    render(<SaveViewButton currentSearch="?subject=UT%3AElections&subject=UT%3AMarriage" onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /save as view/i }))
    expect(screen.getByText(/everyone in your organization/i)).toBeTruthy()
    expect(screen.getByText(/2 filters/i)).toBeTruthy()
  })

  it('excludes sort and dir from the count, though they stay in the stored query', () => {
    render(<SaveViewButton currentSearch="?subject=UT%3AElections&sort=priority&dir=desc" onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /save as view/i }))
    expect(screen.getByText(/1 filter\b/i)).toBeTruthy()
  })

  it('saves the trimmed name', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<SaveViewButton currentSearch="?status=1" onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: /save as view/i }))
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: '  Clerk bills  ' } })
    fireEvent.click(screen.getByRole('button', { name: /^save view$/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Clerk bills'))
  })

  it('does not save a blank name', () => {
    const onSave = vi.fn()
    render(<SaveViewButton currentSearch="?status=1" onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: /save as view/i }))
    fireEvent.click(screen.getByRole('button', { name: /^save view$/i }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('closes on cancel without saving', () => {
    const onSave = vi.fn()
    render(<SaveViewButton currentSearch="?status=1" onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: /save as view/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByLabelText('View name')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })
})
