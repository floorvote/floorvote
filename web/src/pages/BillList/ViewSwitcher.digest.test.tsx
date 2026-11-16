import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewSwitcher, type SavedView } from './ViewSwitcher'
import * as api from '../../lib/api'

// #449: each saved view row ends with an envelope that includes the view in the
// member's email. Outlined when off, filled when on, in a column after the count. A click
// follows or unfollows the view directly (#1035). Its hover names the schedule, or says a click stops it.

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
      digest={digest === undefined ? undefined : { cadence: 'daily', onToggle, ...digest }}
      {...over}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /^views$/i }))
  return { ...utils, onToggle }
}

const envelope = (name: string) => screen.getByRole('button', { name: new RegExp(`^Email me "${name}" (daily|weekly)$`) })
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

  it('names the schedule on hover for a view not followed, and says a click stops it for one that is', async () => {
    renderSwitcher({})
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    await userEvent.hover(envelope('Clerk bills'))
    expect(await screen.findByText('Email me this view daily')).toBeInTheDocument()
    expect(screen.queryByText(/^Stop emailing/)).not.toBeInTheDocument()
    await userEvent.unhover(envelope('Clerk bills'))
    await userEvent.hover(envelope('Auditor bills'))
    expect(await screen.findByText('Stop emailing me this view')).toBeInTheDocument()
    expect(screen.queryByText(/^Email me this view/)).not.toBeInTheDocument()
  })

  it('changes the hover as soon as the view is included or removed, while the pointer is still on the envelope', async () => {
    const { rerender, onToggle } = renderSwitcher({})
    const props = (views: SavedView[]) => (
      <ViewSwitcher
        views={views} currentSearch="" isAdmin={false}
        onApply={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onReorder={vi.fn()} onOverwrite={vi.fn()}
        digest={{ cadence: 'daily', onToggle }}
      />
    )
    await userEvent.hover(envelope('Clerk bills'))
    expect(await screen.findByText('Email me this view daily')).toBeInTheDocument()
    await userEvent.click(envelope('Clerk bills'))
    expect(onToggle).toHaveBeenCalledWith('v1', true)
    rerender(props(VIEWS.map(v => v.id === 'v1' ? { ...v, subscribed: true } : v)))
    expect(await screen.findByText('Stop emailing me this view')).toBeInTheDocument()
    expect(screen.queryByText(/^Email me this view/)).not.toBeInTheDocument()
    await userEvent.click(envelope('Clerk bills'))
    expect(onToggle).toHaveBeenCalledWith('v1', false)
    rerender(props(VIEWS))
    expect(await screen.findByText('Email me this view daily')).toBeInTheDocument()
    expect(screen.queryByText(/^Stop emailing/)).not.toBeInTheDocument()
  })

  it('follows the instance cadence in the envelope hover and the name, on and off', async () => {
    renderSwitcher({ cadence: 'weekly' })
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    expect(envelope('Clerk bills')).toHaveAccessibleName('Email me "Clerk bills" weekly')
    await userEvent.hover(envelope('Clerk bills'))
    expect(await screen.findByText('Email me this view weekly')).toBeInTheDocument()
    await userEvent.unhover(envelope('Clerk bills'))
    expect(envelope('Auditor bills')).toHaveAccessibleName('Email me "Auditor bills" weekly')
    expect(envelope('Auditor bills')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.hover(envelope('Auditor bills'))
    expect(await screen.findByText('Stop emailing me this view')).toBeInTheDocument()
  })

  it('ends the envelope hover with no period, like the app\'s other tooltips, on and off', async () => {
    renderSwitcher({})
    await userEvent.hover(envelope('Clerk bills'))
    expect((await screen.findByText(/^Email me this view/)).textContent).not.toMatch(/[.]$/)
    await userEvent.unhover(envelope('Clerk bills'))
    await userEvent.hover(envelope('Auditor bills'))
    expect((await screen.findByText(/^Stop emailing me this view/)).textContent).not.toMatch(/[.]$/)
  })

  it('no longer puts the bill count on the envelope hover', async () => {
    renderSwitcher({})
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    await userEvent.hover(envelope('Clerk bills'))
    await screen.findByText(/^Email me this view/)
    expect(screen.queryByText(/bills now/)).not.toBeInTheDocument()
    expect(envelope('Clerk bills')).not.toHaveAttribute('title', expect.stringMatching(/bills? now/))
  })

  it('says on hover of the count chip how many bills match the view, with the real count', async () => {
    renderSwitcher({})
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    const chip = screen.getByText('42')
    expect(chip).toHaveAccessibleDescription('42 bills match this view')
    await userEvent.hover(chip)
    expect(await screen.findByText('42 bills match this view')).toBeInTheDocument()
  })

  it('says "1 bill matches this view" for a view of one', async () => {
    renderSwitcher({})
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument())
    const chip = screen.getByText('1')
    expect(chip).toHaveAccessibleDescription('1 bill matches this view')
    await userEvent.hover(chip)
    expect(await screen.findByText('1 bill matches this view')).toBeInTheDocument()
  })

  it('formats a large count with separators in the chip hover', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async () => ({ pagination: { total: 1320 } }) as never)
    renderSwitcher({})
    await waitFor(() => expect(screen.getAllByText('1,320').length).toBeGreaterThan(0))
    await userEvent.hover(screen.getAllByText('1,320')[1])
    expect(await screen.findByText('1,320 bills match this view')).toBeInTheDocument()
  })

  it('leaves the "All bills" count chip without the view hover, since it is not a view', async () => {
    renderSwitcher({})
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument())
    expect(screen.getByText('100')).not.toHaveAccessibleDescription()
    await userEvent.hover(screen.getByText('100'))
    expect(screen.queryByText(/match(es)? this view/)).not.toBeInTheDocument()
  })

  it('gives the count chip no hover until the count has loaded, rather than saying 0', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(() => new Promise(() => {}))
    renderSwitcher({})
    const chips = screen.getAllByText('…')
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) expect(chip).not.toHaveAccessibleDescription()
    await userEvent.hover(chips[0])
    expect(screen.queryByText(/match(es)? this view/)).not.toBeInTheDocument()
  })

  it('keeps the count chip hover on a row with no digest control', async () => {
    renderSwitcher(undefined)
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    await userEvent.hover(screen.getByText('42'))
    expect(await screen.findByText('42 bills match this view')).toBeInTheDocument()
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

  it('never asks to turn the digest on: a click follows the view directly, with no prompt', () => {
    const { onToggle } = renderSwitcher({})
    fireEvent.click(envelope('Clerk bills'))
    expect(onToggle).toHaveBeenCalledWith('v1', true)
    expect(screen.queryByText(/turn on your email digest/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn on digest' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument()
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
