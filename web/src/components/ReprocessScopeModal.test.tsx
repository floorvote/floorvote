import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReprocessScopeModal } from './ReprocessScopeModal'
import type { ComponentProps } from 'react'

function mount(extra?: Partial<ComponentProps<typeof ReprocessScopeModal>>) {
  const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
  const onChoose = vi.fn()
  const onDismiss = vi.fn()
  render(
    <ReprocessScopeModal
      matchedBillsCount={5}
      prioritizedBillsCount={2}
      onChoose={onChoose}
      onDismiss={onDismiss}
      {...extra}
    />,
    { container: root },
  )
  return { onChoose, onDismiss }
}

describe('ReprocessScopeModal', () => {
  it('renders as a named dialog', () => {
    mount()
    expect(screen.getByRole('dialog', { name: /instructions saved/i })).toBeTruthy()
  })

  it('does not auto-focus either confirm (reprocess) action on open', () => {
    mount()
    const confirmButtons = screen.getAllByRole('button', { name: /^yes,/i })
    expect(confirmButtons.length).toBeGreaterThan(0)
    for (const btn of confirmButtons) {
      expect(document.activeElement).not.toBe(btn)
    }
  })

  it('focuses the cancel control on open', () => {
    mount()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /no, just future bill texts/i }))
  })

  it('invokes onChoose("all") when the "all bills" action is clicked', () => {
    const { onChoose } = mount()
    fireEvent.click(screen.getByRole('button', { name: /yes, all 5 fully analyzed bills/i }))
    expect(onChoose).toHaveBeenCalledWith('all')
  })

  it('invokes onChoose("prioritized") when the prioritized action is clicked', () => {
    const { onChoose } = mount()
    fireEvent.click(screen.getByRole('button', { name: /yes, all 2 prioritized bills/i }))
    expect(onChoose).toHaveBeenCalledWith('prioritized')
  })

  it('invokes onDismiss when the cancel control is clicked', () => {
    const { onDismiss } = mount()
    fireEvent.click(screen.getByRole('button', { name: /no, just future bill texts/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('invokes onDismiss on Escape', () => {
    const { onDismiss } = mount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('hides the prioritized option when there are no prioritized bills', () => {
    mount({ prioritizedBillsCount: 0 })
    expect(screen.queryByRole('button', { name: /prioritized/i })).toBeNull()
  })

  it('shows what reprocessing replaces and preserves', () => {
    mount()
    expect(screen.getByText(/Comments, votes, priority, positions, and notes are untouched/)).toBeInTheDocument()
  })
})
