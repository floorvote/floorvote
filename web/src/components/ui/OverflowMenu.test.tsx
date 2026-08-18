import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OverflowMenu, type OverflowMenuRow } from './OverflowMenu'

function makeRows(overrides?: Partial<OverflowMenuRow>[]): OverflowMenuRow[] {
  return [
    { key: 'copy', label: 'Copy link', description: 'A description', onSelect: vi.fn(), ...overrides?.[0] },
    { key: 'regen', label: 'Re-generate', onSelect: vi.fn(), ...overrides?.[1] },
    { key: 'delete', label: 'Delete', onSelect: vi.fn(), tone: 'danger' as const, ...overrides?.[2] },
  ]
}

describe('OverflowMenu', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('renders a trigger button with aria-label "More actions"', () => {
    render(<OverflowMenu rows={makeRows()} />)
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument()
  })

  it('opens a menu on click with all row labels', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<OverflowMenu rows={makeRows()} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Copy link/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Re-generate/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument()
  })

  it('renders the description text beneath the label', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<OverflowMenu rows={makeRows()} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByText('A description')).toBeInTheDocument()
  })

  it('calls onSelect and closes the menu when a row is clicked', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const rows = makeRows()
    render(<OverflowMenu rows={rows} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByRole('menuitem', { name: /Copy link/ }))
    expect(rows[0].onSelect).toHaveBeenCalledTimes(1)
    // Menu should close after the PopPanel exit animation
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not call onSelect on a disabled row', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const rows = makeRows([{}, { disabled: true }, {}])
    render(<OverflowMenu rows={rows} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByRole('menuitem', { name: /Re-generate/ }))
    expect(rows[1].onSelect).not.toHaveBeenCalled()
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<OverflowMenu rows={makeRows()} />)
    const trigger = screen.getByRole('button', { name: 'More actions' })
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('supports arrow-key navigation with wrapping', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<OverflowMenu rows={makeRows()} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    const items = screen.getAllByRole('menuitem')
    // Focus first item, arrow down to second
    items[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()
    // Arrow down past last wraps to first
    await user.keyboard('{ArrowDown}')
    expect(items[2]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(items[0]).toHaveFocus()
  })

  it('Home/End jump to first/last row', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<OverflowMenu rows={makeRows()} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    const items = screen.getAllByRole('menuitem')
    items[0].focus()
    await user.keyboard('{End}')
    expect(items[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(items[0]).toHaveFocus()
  })

  it('skips disabled rows during arrow navigation', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const rows = makeRows([{}, { disabled: true }, {}])
    render(<OverflowMenu rows={rows} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    const items = screen.getAllByRole('menuitem').filter(el => !el.hasAttribute('disabled'))
    items[0].focus()
    await user.keyboard('{ArrowDown}')
    // Should skip the disabled row and land on the third
    expect(items[1]).toHaveFocus()
  })

  it('sets aria-expanded on the trigger', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<OverflowMenu rows={makeRows()} />)
    const trigger = screen.getByRole('button', { name: 'More actions' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })
})
