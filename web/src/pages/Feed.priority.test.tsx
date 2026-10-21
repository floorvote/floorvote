/**
 * Feed: the priority control on a bill card (#911)
 *
 * The card's dropdown saves through the API, and the Feed updates the card in
 * place: the bill's events (and a companion group's, whichever member the card
 * was set on) take the new priority, with no reload of the feed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const apiFetchMock = vi.fn()
// The feed's 20-second poll, held so a test can fire it.
const poll = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock('../hooks/usePolling', () => ({ usePolling: (fn: () => Promise<void>) => { poll.fn = fn; return { forceRefresh: () => {} } } }))
vi.mock('../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  ApiError: class extends Error {},
}))
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
const authMock = vi.fn()
vi.mock('../hooks/useAuth', () => ({ useAuth: () => authMock() }))

import { Feed } from './Feed'
import { SidebarRefreshProvider, useRegisterSidebarRefresh } from '../context/SidebarRefreshContext'
import { expectAmber, expectNotAmber } from '../test/amberStyle'
import type { FeedEvent } from '../lib/feedUtils'

const base = {
  billSessionSlug: '2026rs', billState: 'RI', billSummary: null, billPriority: null, billMatchType: 'keyword' as const,
  billGroupKey: null, billNewMatch: false, userId: 'u2', userName: 'Ada Admin', userTitle: null,
}
const ev = (over: Partial<FeedEvent> & { id: string }): FeedEvent => ({
  ...base, type: 'comment_added', billId: 'b1', billNumber: 'HB 1', billTitle: 'Mail Ballot Rules',
  metadata: { preview: 'hello' }, createdAt: '2026-02-01 10:00:00', ...over,
} as FeedEvent)

const refreshSidebar = vi.fn()
function Registrar() { useRegisterSidebarRefresh(refreshSidebar); return null }

function renderFeed(events: FeedEvent[]) {
  return render(
    <MemoryRouter>
      <SidebarRefreshProvider>
        <Registrar />
        <Feed preloaded={{ events, total: events.length, page: 1, limit: 40 } as never} />
      </SidebarRefreshProvider>
    </MemoryRouter>,
  )
}

const selects = () => screen.queryAllByRole('combobox', { name: /priority/i })
// The first control, failing with a clear "no control" message when there is none.
const sel = (): HTMLElement => screen.getAllByRole('combobox', { name: /priority/i })[0]
const asAdmin = () => authMock.mockReturnValue({ user: { id: 'u1', role: 'admin' } })

beforeEach(() => {
  poll.fn = null
  apiFetchMock.mockReset()
  refreshSidebar.mockReset()
  asAdmin()
})

describe('Feed: an admin sees the priority control on each bill card', () => {
  it('shows one on every bill card, "Set priority" or the current priority', () => {
    renderFeed([
      ev({ id: 'e1', billId: 'b1', billNumber: 'HB 1', billTitle: 'No Priority Bill' }),
      ev({ id: 'e2', billId: 'b2', billNumber: 'HB 2', billTitle: 'Has Priority Bill', billPriority: 'medium' }),
    ])
    const [first, second] = [screen.getByText('No Priority Bill'), screen.getByText('Has Priority Bill')]
    expect(first).toBeInTheDocument()
    expect(second).toBeInTheDocument()
    expect(selects().map(s => (s as HTMLSelectElement).value).sort()).toEqual(['', 'medium'])
  })

  it('an owner gets it too', () => {
    authMock.mockReturnValue({ user: { id: 'u1', role: 'owner' } })
    renderFeed([ev({ id: 'e1' })])
    expect(selects()).toHaveLength(1)
  })

  it('a member gets none, and an unprioritized card shows nothing there', () => {
    authMock.mockReturnValue({ user: { id: 'u1', role: 'member' } })
    renderFeed([ev({ id: 'e1' }), ev({ id: 'e2', billId: 'b2', billNumber: 'HB 2', billTitle: 'Has Priority Bill', billPriority: 'high' })])
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.getByText('High priority')).toBeInTheDocument()
  })

  it('a member sees "New match" on an untriaged new match', () => {
    authMock.mockReturnValue({ user: { id: 'u1', role: 'member' } })
    renderFeed([ev({ id: 'e1', billNewMatch: true })])
    expect(screen.getByText('New match')).toBeInTheDocument()
  })

  it('a bill-less activity row has no control', () => {
    renderFeed([{
      ...base, id: 'bulk', type: 'priority_set', billId: null, billNumber: '', billTitle: '', billMatchType: null,
      metadata: { priority: 'high', count: 3, billIds: ['b1'] }, createdAt: '2026-02-01 11:00:00',
    } as FeedEvent])
    expect(screen.getByText('Ada Admin set priority to high on 3 bills')).toBeInTheDocument()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })
})

describe('Feed: choosing a priority updates the card in place', () => {
  it('shows the saved priority on the card, saved against that bill, without refetching the feed', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high', promoted: false })
    renderFeed([ev({ id: 'e1' }), ev({ id: 'e3', billId: 'b2', billNumber: 'HB 2', billTitle: 'Other Bill', createdAt: '2026-02-01 09:00:00' })])
    const first = within(screen.getByText('Mail Ballot Rules').closest('div[style*="cursor: pointer"]') as HTMLElement)
    fireEvent.change(first.getByRole('combobox'), { target: { value: 'high' } })
    await waitFor(() => expect(first.getByRole('combobox')).toHaveValue('high'))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })
    // The other bill's card is untouched.
    expect(selects().map(s => (s as HTMLSelectElement).value).sort()).toEqual(['', 'high'])
  })

  it('changes a priority that is already set: High to Low saves and the card shows Low', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'low' })
    renderFeed([ev({ id: 'e1', billPriority: 'high' })])
    expect(sel()).toHaveDisplayValue('High Priority')
    fireEvent.change(sel(), { target: { value: 'low' } })
    await waitFor(() => expect(sel()).toHaveDisplayValue('Low Priority'))
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'low' }) })
  })

  it('a card for a bill with several events shows the new priority once', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'low' })
    renderFeed([ev({ id: 'e1' }), ev({ id: 'e2', createdAt: '2026-02-01 08:00:00' })])
    fireEvent.change(sel(), { target: { value: 'low' } })
    await waitFor(() => expect(sel()).toHaveValue('low'))
    expect(selects()).toHaveLength(1)
  })

  it('clearing the priority shows "Set priority" again', async () => {
    apiFetchMock.mockResolvedValue({ priority: null })
    renderFeed([ev({ id: 'e1', billPriority: 'medium' })])
    fireEvent.change(sel(), { target: { value: '' } })
    await waitFor(() => expect(sel()).toHaveDisplayValue('Set priority'))
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', { method: 'PATCH', body: JSON.stringify({ priority: null }) })
  })

  it('keeps a card in view when clearing its priority would otherwise hide it from the default feed', async () => {
    apiFetchMock.mockResolvedValue({ priority: null })
    // Only a provider update: the default feed shows this card for its priority alone.
    renderFeed([ev({
      id: 'e1', type: 'bill_updated', billPriority: 'high',
      metadata: { changes: [{ changeType: 'action_added', newValue: 'Referred to committee' }] },
    })])
    fireEvent.change(sel(), { target: { value: '' } })
    await waitFor(() => expect(sel()).toHaveDisplayValue('Set priority'))
    expect(screen.getByText('Mail Ballot Rules')).toBeInTheDocument()
  })

  it('leaves the card as it was when the save fails', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    renderFeed([ev({ id: 'e1', billPriority: 'low' })])
    fireEvent.change(sel(), { target: { value: 'high' } })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0))
    expect(sel()).toHaveValue('low')
    expect(refreshSidebar).not.toHaveBeenCalled()
  })

  it('refreshes the sidebar, whose priority counts changed', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high' })
    renderFeed([ev({ id: 'e1' })])
    fireEvent.change(sel(), { target: { value: 'high' } })
    await waitFor(() => expect(refreshSidebar).toHaveBeenCalledTimes(1))
  })

  it('setting a priority resolves a new match: the control is no longer amber', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'medium' })
    renderFeed([ev({ id: 'e1', billNewMatch: true })])
    expectAmber(sel())
    fireEvent.change(sel(), { target: { value: 'medium' } })
    await waitFor(() => expect(sel()).toHaveValue('medium'))
    expectNotAmber(sel())
  })
})

describe('Feed: Dismiss on a new match', () => {
  it('triages the bill and turns the control into a plain "Set priority"', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    renderFeed([ev({ id: 'e1', billNewMatch: true }), ev({ id: 'e2', createdAt: '2026-02-01 08:00:00', billNewMatch: true })])
    expect(sel()).toHaveDisplayValue('New · Set priority')
    fireEvent.change(sel(), { target: { value: 'dismiss' } })
    await waitFor(() => expect(sel()).toHaveDisplayValue('Set priority'))
    expectNotAmber(sel())
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/triage-dismiss', { method: 'PATCH' })
    expect(refreshSidebar).toHaveBeenCalledTimes(1)
  })

  it('a failed Dismiss leaves the amber control in place', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    renderFeed([ev({ id: 'e1', billNewMatch: true })])
    fireEvent.change(sel(), { target: { value: 'dismiss' } })
    await screen.findByRole('alert')
    expectAmber(sel())
  })
})

describe('Feed: a companion group\'s card', () => {
  const companions = (over: Partial<FeedEvent> = {}) => [
    ev({ id: 'e2', billId: 's1', billNumber: 'S 202', billGroupKey: 'h1', createdAt: '2026-02-01 12:00:00', ...over }),
    ev({ id: 'e1', billId: 'h1', billNumber: 'H 101', billGroupKey: 'h1', createdAt: '2026-02-01 10:00:00', ...over }),
  ]

  it('is one card with one control, showing the group\'s priority', () => {
    renderFeed(companions({ billPriority: 'high' }))
    expect(selects()).toHaveLength(1)
    expect(sel()).toHaveValue('high')
  })

  it('sets the group\'s priority from the card, and the card shows it', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'low' })
    renderFeed(companions())
    fireEvent.change(sel(), { target: { value: 'low' } })
    await waitFor(() => expect(sel()).toHaveValue('low'))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    // The card's own (newest-event) bill carries the write; the server sets the group's.
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/s1/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'low' }) })
  })

  it('does not touch the card of an unrelated bill', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'low' })
    renderFeed([...companions(), ev({ id: 'e9', billId: 'z9', billNumber: 'HB 9', billTitle: 'Unrelated', createdAt: '2026-02-01 07:00:00' })])
    const groupSelect = sel()
    fireEvent.change(groupSelect, { target: { value: 'low' } })
    await waitFor(() => expect(selects().map(s => (s as HTMLSelectElement).value).sort()).toEqual(['', 'low']))
  })

  it('Dismiss triages the group\'s card', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    renderFeed(companions({ billNewMatch: true }))
    fireEvent.change(sel(), { target: { value: 'dismiss' } })
    await waitFor(() => expect(sel()).toHaveDisplayValue('Set priority'))
  })
})

describe('Feed: clearing a priority on a plain bill', () => {
  it('a plain bill stays plain when its priority is cleared', async () => {
    apiFetchMock.mockResolvedValue({ priority: null })
    renderFeed([ev({ id: 'e1', billPriority: 'medium', billNewMatch: false })])
    fireEvent.change(sel(), { target: { value: '' } })
    await waitFor(() => expect(sel()).toHaveDisplayValue('Set priority'))
    expectNotAmber(sel())
  })
})

describe('Feed: a companion group\'s cards on other days', () => {
  it('shows the group\'s new priority on its card from another day too', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high' })
    renderFeed([
      ev({ id: 'e3', billId: 's1', billNumber: 'S 202', billGroupKey: 'h1', createdAt: '2026-02-03 12:00:00' }),
      ev({ id: 'e1', billId: 'h1', billNumber: 'H 101', billGroupKey: 'h1', createdAt: '2026-02-01 10:00:00' }),
    ])
    expect(selects()).toHaveLength(2)
    fireEvent.change(sel(), { target: { value: 'high' } })
    await waitFor(() => expect(selects().map(s => (s as HTMLSelectElement).value)).toEqual(['high', 'high']))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves another day\'s card of an unrelated bill alone', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high' })
    renderFeed([
      ev({ id: 'e3', billId: 's1', billNumber: 'S 202', billGroupKey: 'h1', createdAt: '2026-02-03 12:00:00' }),
      ev({ id: 'e1', billId: 'z9', billNumber: 'HB 9', billTitle: 'Unrelated', createdAt: '2026-02-01 10:00:00' }),
    ])
    fireEvent.change(sel(), { target: { value: 'high' } })
    await waitFor(() => expect(selects().map(s => (s as HTMLSelectElement).value)).toEqual(['high', '']))
  })
})

describe('Feed: a card an admin cleared stays through a poll and goes after a scope switch', () => {
  const passiveOnly = (over: Partial<FeedEvent> = {}) => ev({
    id: 'e1', type: 'bill_updated', metadata: { changes: [{ changeType: 'action_added', newValue: 'Referred to committee' }] }, ...over,
  })

  it('keeps the edited card when a poll brings new activity', async () => {
    apiFetchMock.mockResolvedValue({ priority: null })
    renderFeed([passiveOnly({ billPriority: 'high' })])
    fireEvent.change(sel(), { target: { value: '' } })
    await waitFor(() => expect(sel()).toHaveDisplayValue('Set priority'))
    // The server now has no priority on the bill and a newer provider update on it.
    apiFetchMock.mockResolvedValue({
      events: [passiveOnly({ id: 'e-new', createdAt: '2026-02-01 11:00:00' }), passiveOnly()], total: 2, page: 1, limit: 40,
    })
    await act(async () => { await poll.fn!() })
    expect(screen.getByText('Mail Ballot Rules')).toBeInTheDocument()
    expect(sel()).toHaveDisplayValue('Set priority')
  })

  it('drops a cleared passive-only card once the scope is switched away and back', async () => {
    const reply = { events: [passiveOnly()], total: 1, page: 1, limit: 40 }
    apiFetchMock.mockImplementation(async (path: string) => path.startsWith('/feed') ? reply : { priority: null })
    renderFeed([passiveOnly({ billPriority: 'high' })])
    fireEvent.change(sel(), { target: { value: '' } })
    await waitFor(() => expect(sel()).toHaveDisplayValue('Set priority'))
    expect(screen.getByText('Mail Ballot Rules')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /default feed/i }))
    fireEvent.click(screen.getByText('All analyzed bills'))
    // Every analyzed bill is listed, so the card is in this scope on its own.
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('scope=analyzed')))
    expect(await screen.findByText('Mail Ballot Rules')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /all analyzed bills/i }))
    fireEvent.click(screen.getByText('Default feed'))
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('scope=default')))
    // No priority and only a provider update: the default feed hides it again.
    await waitFor(() => expect(screen.queryByText('Mail Ballot Rules')).toBeNull())
  })
})
