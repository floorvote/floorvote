import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Dialog } from './Dialog'

function mount(extra?: Partial<React.ComponentProps<typeof Dialog>>) {
  const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
  const onClose = vi.fn()
  render(
    <Dialog onClose={onClose} labelledBy="t" {...extra}>
      <h2 id="t">Send feedback</h2>
      <input aria-label="message" />
    </Dialog>,
    { container: root },
  )
  return { onClose, root }
}

describe('Dialog', () => {
  it('renders role=dialog, aria-modal, and an accessible name', () => {
    mount()
    const d = screen.getByRole('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.getAttribute('aria-labelledby')).toBe('t')
  })

  it('moves focus inside on open', () => {
    mount()
    expect(document.activeElement).toBe(screen.getByLabelText('message'))
  })

  it('closes on Escape', () => {
    const { onClose } = mount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop click by default, not on card click', () => {
    const { onClose } = mount()
    fireEvent.click(screen.getByTestId('dialog-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
