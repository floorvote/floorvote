import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewSwitcher, type SavedView } from './ViewSwitcher'
import * as api from '../../lib/api'

// #449: each saved view row ends with an envelope that includes the view in the
// member's email digest. Outlined when off, filled when on, in a column after the
// count. Its hover says what it does and how many bills the view holds now.

const demoState = vi.hoisted(() => ({ demoMode: false, settled: true }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: demoState.demoMode, demoLocked: false, settled: demoState.settled }),
}))

const VIEWS: SavedView[] = [
  { id: 'v1', name: 'Clerk bills', query: 'subject=UT%3AElections', subscribed: false },
  { id: 'v2', name: 'Auditor bills', query: 'subject=UT%3AAudits', subscribed: true },
]

type Digest = NonNullable<Parameters<typeof ViewSwitcher>[0]['digest']>

function renderSwitcher(digest: Partial<Digest> | undefined, over: Partial<Parameters<typeof ViewSwitcher>[0]> = {}) {
  const onToggle = vi.fn()
  const onTurnOn = vi.fn()
  const utils = render(
    <ViewSwitcher
      views={VIEWS}
      currentSearch=""
      isAdmin={false}
      onApply={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onReorder={vi.fn()}
      onOverwrite={vi.fn()}
      digest={digest === undefined ? undefined : { cadence: 'daily', memberOn: true, onToggle, onTurnOn, ...digest }}
      {...over}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /^views$/i }))
  return { ...utils, onToggle, onTurnOn }
}

const envelope = (name: string) => screen.getByRole('button', { name: new RegExp(`"${name}" (in|from) your (daily|weekly) digest`, 'i') })
const glyph = (el: HTMLElement) => within(el).getByText('mail')

describe('ViewSwitcher: include a view in the digest', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    demoState.demoMode = false
    demoState.settled = true
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path) => {
      const p = String(path)
      if (p.includes('subject=UT%3AAudits')) return { pagination: { total: 1 } } as never
      if (p.includes('subject=UT%3AElections')) return { pagination: { total: 42 } } as never
      return { pagination: { total: 100 } } as never
    })
  })

  it('shows no envelope when the digest control is not offered (the instance digest is off)', () => {
    const offered = renderSwitcher({})
    expect(screen.getAllByText('mail')).toHaveLength(2)
    offered.unmount()
    renderSwitcher(undefined)
    expect(screen.queryByText('mail')).not.toBeInTheDocument()
  })

  it('shows one envelope per view row and none on "All bills"', () => {
    renderSwitcher({})
    expect(screen.getAllByText('mail')).toHaveLength(2)
    const allBills = screen.getByText('All bills').closest('button') as HTMLElement
    expect(within(allBills).queryByText('mail')).not.toBeInTheDocument()
  })

  it('draws an unsubscribed view\'s envelope outlined and a subscribed view\'s filled, and says which in its state', () => {
    renderSwitcher({})
    expect(glyph(envelope('Clerk bills'))).toHaveAttribute('data-filled', 'false')
    expect(envelope('Clerk bills')).toHaveAttribute('aria-pressed', 'false')
    expect(glyph(envelope('Auditor bills'))).toHaveAttribute('data-filled', 'true')
    expect(envelope('Auditor bills')).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the envelope after the count, in a column that is the same width on every row', async () => {
    renderSwitcher({})
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    for (const [name, count] of [['Clerk bills', '42'], ['Auditor bills', '1']] as const) {
      const badge = screen.getByText(count)
      expect(badge.compareDocumentPosition(envelope(name)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    const widths = [envelope('Clerk bills'), envelope('Auditor bills')].map(e => e.style.width)
    expect(widths[0]).not.toBe('')
    expect(widths[0]).toBe(widths[1])
  })

  it('says on hover what the click does and how many bills the view holds now', async () => {
    renderSwitcher({})
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    await userEvent.hover(envelope('Clerk bills'))
    expect(await screen.findByText('Include this view in your daily digest · 42 bills now')).toBeInTheDocument()
  })

  it('says "1 bill now" for a view of one, and removal for a view already included', async () => {
    renderSwitcher({})
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    await userEvent.hover(envelope('Auditor bills'))
    expect(await screen.findByText('Remove this view from your daily digest · 1 bill now')).toBeInTheDocument()
  })

  it('follows the instance cadence in the hover and the name', async () => {
    renderSwitcher({ cadence: 'weekly' })
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    expect(envelope('Clerk bills')).toHaveAccessibleName('Include "Clerk bills" in your weekly digest')
    await userEvent.hover(envelope('Clerk bills'))
    expect(await screen.findByText('Include this view in your weekly digest · 42 bills now')).toBeInTheDocument()
  })

  it('leaves the count off the hover until it has loaded, rather than saying 0', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(() => new Promise(() => {}))
    renderSwitcher({})
    await userEvent.hover(envelope('Clerk bills'))
    expect(await screen.findByText('Include this view in your daily digest')).toBeInTheDocument()
    expect(screen.queryByText(/bills now/)).not.toBeInTheDocument()
  })

  it('includes the view on a click, with the digest on, and does not apply the view or close the menu', () => {
    const onApply = vi.fn()
    const { onToggle } = renderSwitcher({}, { onApply })
    fireEvent.click(envelope('Clerk bills'))
    expect(onToggle).toHaveBeenCalledWith('v1', true)
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: /saved views/i })).toBeInTheDocument()
  })

  it('removes an included view on a click', () => {
    const { onToggle } = renderSwitcher({})
    fireEvent.click(envelope('Auditor bills'))
    expect(onToggle).toHaveBeenCalledWith('v2', false)
  })

  it('is reachable by keyboard like any button', async () => {
    const { onToggle } = renderSwitcher({})
    envelope('Clerk bills').focus()
    await userEvent.keyboard('{Enter}')
    expect(onToggle).toHaveBeenCalledWith('v1', true)
  })

  it('offers to turn the digest on when the member has it off, and includes nothing yet', () => {
    const { onToggle, onTurnOn } = renderSwitcher({ memberOn: false })
    fireEvent.click(envelope('Clerk bills'))
    expect(screen.getByText(/turn on your email digest to include "clerk bills"/i)).toBeInTheDocument()
    expect(onToggle).not.toHaveBeenCalled()
    expect(onTurnOn).not.toHaveBeenCalled()
  })

  it('turns the digest on and then includes the view, on "Turn on digest"', async () => {
    const calls: string[] = []
    const { onToggle, onTurnOn } = renderSwitcher({ memberOn: false })
    onTurnOn.mockImplementation(async () => { calls.push('on') })
    onToggle.mockImplementation(async () => { calls.push('toggle') })
    fireEvent.click(envelope('Clerk bills'))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on digest' }))
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith('v1', true))
    expect(calls).toEqual(['on', 'toggle'])
    await waitFor(() => expect(screen.queryByText(/turn on your email digest/i)).not.toBeInTheDocument())
  })

  it('includes nothing and turns nothing on when the member says "Not now"', () => {
    const { onToggle, onTurnOn } = renderSwitcher({ memberOn: false })
    fireEvent.click(envelope('Clerk bills'))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onToggle).not.toHaveBeenCalled()
    expect(onTurnOn).not.toHaveBeenCalled()
    expect(screen.queryByText(/turn on your email digest/i)).not.toBeInTheDocument()
  })

  it('does not include the view when turning the digest on fails', async () => {
    const { onToggle, onTurnOn } = renderSwitcher({ memberOn: false })
    onTurnOn.mockRejectedValue(new Error('boom'))
    fireEvent.click(envelope('Clerk bills'))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on digest' }))
    await waitFor(() => expect(onTurnOn).toHaveBeenCalled())
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('lets a member with the digest off still remove a view they included earlier, with no prompt', () => {
    const { onToggle } = renderSwitcher({ memberOn: false })
    fireEvent.click(envelope('Auditor bills'))
    expect(onToggle).toHaveBeenCalledWith('v2', false)
    expect(screen.queryByText(/turn on your email digest/i)).not.toBeInTheDocument()
  })

  it('shows no envelope on a demo tenant, where the digest never sends', () => {
    const live = renderSwitcher({})
    expect(screen.getAllByText('mail')).toHaveLength(2)
    live.unmount()
    demoState.demoMode = true
    renderSwitcher({})
    expect(screen.queryByText('mail')).not.toBeInTheDocument()
  })
})
