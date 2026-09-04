import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { ViewSwitcher, type SavedView } from './ViewSwitcher'
import * as api from '../../lib/api'

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
  beforeEach(() => vi.restoreAllMocks())

  it('does not fetch match counts before the menu is opened', () => {
    const spy = vi.spyOn(api, 'apiFetch')
    renderSwitcher()
    expect(spy).not.toHaveBeenCalled()
  })

  it('fetches and renders match counts after opening the menu', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockImplementation(async (path) => {
      const p = String(path)
      if (p.includes('subject=UT%3AAudits')) return { pagination: { total: 7 } } as never
      if (p.includes('subject=UT%3AElections')) return { pagination: { total: 42 } } as never
      return { pagination: { total: 100 } } as never // "All bills" — no filter params
    })
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: /views/i }))

    // A minimal-page-size /bills request per row: one for "All bills", one per view.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3))
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\/bills\?page=1&pageSize=1$/))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('subject=UT%3AElections'))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('subject=UT%3AAudits'))

    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument())
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('renders a failed count as no number, not 0', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path) => {
      if (String(path).includes('subject=UT%3AAudits')) throw new Error('boom')
      return { pagination: { total: 42 } } as never
    })
    renderSwitcher()
    fireEvent.click(screen.getByRole('button', { name: /views/i }))

    await waitFor(() => expect(screen.getAllByText('42').length).toBeGreaterThan(0))
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

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

  it('reaches Rename via focus alone, with no mouseEnter — keyboard/touch users have no other path', () => {
    renderSwitcher({ isAdmin: true })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
    fireEvent.focus(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.getAllByRole('button', { name: /rename/i })[0]).toBeTruthy()
    fireEvent.blur(screen.getByText('Clerk bills').closest('div')!)
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull()
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

  it('keeps the rename input open when onRename rejects', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('boom'))
    renderSwitcher({ isAdmin: true, onRename })
    fireEvent.click(screen.getByRole('button', { name: /views/i }))
    fireEvent.mouseEnter(screen.getByText('Clerk bills').closest('div')!)
    fireEvent.click(screen.getAllByRole('button', { name: /rename/i })[0])
    const input = screen.getByLabelText('View name')
    fireEvent.change(input, { target: { value: 'County clerk bills' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('v1', 'County clerk bills'))
    // The rejection must not close the row as though the rename succeeded —
    // the input stays open (and keeps the edited draft) so the user can see
    // the rename didn't take.
    expect(screen.getByLabelText('View name')).toBeTruthy()
    expect(screen.getByLabelText('View name')).toHaveValue('County clerk bills')
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
