import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { ViewSwitcher, type SavedView } from './ViewSwitcher'

const VIEWS: SavedView[] = [
  { id: 'v1', name: 'Clerk bills', query: 'subject=UT%3AElections' },
  { id: 'v2', name: 'Auditor bills', query: 'subject=UT%3AAudits' },
]

function renderSwitcher(over: Partial<Parameters<typeof ViewSwitcher>[0]> = {}) {
  const onApply = vi.fn()
  const onRename = vi.fn()
  const onDelete = vi.fn()
  const utils = render(
    <ViewSwitcher
      views={VIEWS}
      currentSearch=""
      isAdmin={false}
      onApply={onApply}
      onRename={onRename}
      onDelete={onDelete}
      {...over}
    />,
  )
  return { ...utils, onApply, onRename, onDelete }
}

describe('ViewSwitcher', () => {
  it('renders nothing when no views exist', () => {
    const { container } = renderSwitcher({ views: [] })
    expect(container).toBeEmptyDOMElement()
  })

  it('reads "Views" when no view matches the current filters', () => {
    renderSwitcher({ currentSearch: '?status=1' })
    expect(screen.getByRole('button', { name: /views/i })).toBeTruthy()
  })

  it('names the active view when the filters match it', () => {
    renderSwitcher({ currentSearch: '?subject=UT%3AElections' })
    expect(screen.getByRole('button', { name: /clerk bills/i })).toBeTruthy()
  })

  it('falls back to "Views" once the filters diverge', () => {
    renderSwitcher({ currentSearch: '?subject=UT%3AElections&status=1' })
    expect(screen.queryByRole('button', { name: /clerk bills/i })).toBeNull()
    expect(screen.getByRole('button', { name: /views/i })).toBeTruthy()
  })

  it('applies a view when its row is chosen', () => {
    const { onApply } = renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.click(screen.getByText('Auditor bills'))
    expect(onApply).toHaveBeenCalledWith(VIEWS[1])
  })

  it('applies null when "All bills" is chosen', () => {
    const { onApply } = renderSwitcher({ currentSearch: '?subject=UT%3AElections' })
    fireEvent.click(screen.getByRole('button', { name: /clerk bills/i }))
    fireEvent.click(screen.getByText('All bills'))
    expect(onApply).toHaveBeenCalledWith(null)
  })

  it('shows no rename or delete affordance to a member', () => {
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('renames through an inline input for an admin', () => {
    const { onRename } = renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    fireEvent.click(screen.getAllByRole('button', { name: /rename/i })[0])
    const input = screen.getByLabelText('View name')
    fireEvent.change(input, { target: { value: 'County clerk bills' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onRename).toHaveBeenCalledWith('v1', 'County clerk bills')
  })

  it('requires a confirm step before deleting, and says it affects everyone', () => {
    const { onDelete } = renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByText(/delete for everyone/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(onDelete).toHaveBeenCalledWith('v1')
  })
})
