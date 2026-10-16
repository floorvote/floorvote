import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../lib/api'
import { GroupWithDialog } from './GroupWithDialog'
import { contrast, resolveColor } from '../test/colorTokens'

// The "Group bills" button must read in both color modes, enabled and while it
// waits for a bill (it stays focusable then, to say what's missing). White text
// on the blue fill was 3.7:1 in light mode and about 2:1 on the muted fill, and
// `white` is the card surface, so it only read in dark mode by accident.

const OPTIONS = [
  { id: 'b2', billNumber: 'HB 2', title: 'Another bill', state: 'XX', isDraft: false },
]

function renderDialog() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/calendar/bill-options') return OPTIONS as never
    return {} as never
  })
  render(<GroupWithDialog billId="b1" billNumber="HB 1" groupBillIds={['b1']} onGrouped={() => {}} onClose={() => {}} />)
  return screen.getByRole('dialog')
}

function expectReadable(button: HTMLElement) {
  for (const mode of ['light', 'dark'] as const) {
    const fg = resolveColor(button.style.color, mode)
    const bg = resolveColor(button.style.background || button.style.backgroundColor, mode)
    const ratio = contrast(fg, bg)
    expect(ratio, `${mode}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
  }
}

describe('GroupWithDialog button contrast', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('reads at AA in both modes while waiting for a bill', () => {
    const dialog = renderDialog()
    const button = within(dialog).getByRole('button', { name: 'Group bills' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expectReadable(button)
  })

  it('reads at AA in both modes once a bill is picked', async () => {
    const user = userEvent.setup()
    const dialog = renderDialog()
    await user.type(within(dialog).getByPlaceholderText('Search bills…'), 'HB')
    await user.click(await within(dialog).findByRole('button', { name: /HB 2/ }))
    const button = within(dialog).getByRole('button', { name: 'Group bills' })
    expect(button).not.toHaveAttribute('aria-disabled')
    expectReadable(button)
  })
})
