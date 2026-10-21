/**
 * Feed: one feed, no scope (#922)
 *
 * The Feed used to offer a scope dropdown, "Default feed" and "All analyzed
 * bills". The daily row for bills with no priority (#919) carries that
 * movement now, so the header holds the title alone and no request names a
 * scope. The card an admin edits stays for the visit with no switch to clear it.
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

import { Feed, feedLoader } from './Feed'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import type { FeedEvent } from '../lib/feedUtils'
import { expectClosedLabel } from '../test/closedLabel'

const base = {
  billSessionSlug: '2026rs', billState: 'RI', billSummary: null, billPriority: null, billMatchType: 'keyword' as const,
  billGroupKey: null, billNewMatch: false, userId: 'u2', userName: 'Ada Admin', userTitle: null,
}
const ev = (over: Partial<FeedEvent> & { id: string }): FeedEvent => ({
  ...base, type: 'comment_added', billId: 'b1', billNumber: 'HB 1', billTitle: 'Mail Ballot Rules',
  metadata: { preview: 'hello' }, createdAt: '2026-02-01 10:00:00', ...over,
} as FeedEvent)
const passiveOnly = (over: Partial<FeedEvent> = {}) => ev({
  id: 'e1', type: 'bill_updated', metadata: { changes: [{ changeType: 'action_added', newValue: 'Referred to committee' }] }, ...over,
})

function renderFeed(preloaded: { events: FeedEvent[]; total: number } | null) {
  return render(
    <MemoryRouter>
      <SidebarRefreshProvider>
        <Feed preloaded={preloaded ? ({ ...preloaded, page: 1, limit: 40 } as never) : null} />
      </SidebarRefreshProvider>
    </MemoryRouter>,
  )
}
const sel = (): HTMLElement => screen.getAllByRole('combobox', { name: /priority/i })[0]
const feedPaths = () => apiFetchMock.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith('/feed'))

beforeEach(() => {
  poll.fn = null
  apiFetchMock.mockReset()
  authMock.mockReturnValue({ user: { id: 'u1', role: 'admin' } })
})

describe('the Feed header', () => {
  it('holds the title and no scope control', () => {
    renderFeed({ events: [], total: 0 })
    const header = screen.getByRole('heading', { name: 'Feed' }).parentElement!
    expect(within(header).queryAllByRole('button')).toEqual([])
    expect(screen.queryByText(/default feed/i)).toBeNull()
    expect(screen.queryByText(/all analyzed bills/i)).toBeNull()
  })

  it('shows the title and no scope control for a member too', () => {
    authMock.mockReturnValue({ user: { id: 'u1', role: 'member' } })
    renderFeed({ events: [ev({ id: 'c1' })], total: 1 })
    const header = screen.getByRole('heading', { name: 'Feed' }).parentElement!
    expect(within(header).queryAllByRole('button')).toEqual([])
  })
})

describe('the Feed\'s requests', () => {
  it('names no scope on the first load, a page of scrolling, or the poll', async () => {
    // Each page holds one team comment on its own bill; the total says two pages exist.
    const page = (n: number) => ({ events: [ev({ id: `c${n}`, billId: `b${n}`, billTitle: `Bill ${n}`, createdAt: `2026-02-0${n} 10:00:00` })], total: 2, page: n, limit: 40 })
    apiFetchMock.mockImplementation(async (path: string) => page(path.includes('page=2') ? 2 : 1))
    renderFeed(null)
    // The first load pulls page 1, then page 2 to fill the screen.
    await waitFor(() => expect(screen.getByText('Bill 2')).toBeInTheDocument())
    await act(async () => { await poll.fn!() })

    expect(feedPaths().length).toBeGreaterThanOrEqual(3)
    expect(feedPaths().filter((p) => /scope/i.test(p))).toEqual([])
  })

  it('names no scope in the route loader\'s request', async () => {
    apiFetchMock.mockResolvedValue({ events: [], total: 0, page: 1, limit: 40 })
    await feedLoader({ request: new Request('http://localhost/') })
    expect(feedPaths()).toEqual(['/feed?page=1&limit=40'])
  })
})

describe('a card an admin edited stays for the visit', () => {
  it('keeps a cleared passive-only card through every poll, with no scope to switch', async () => {
    apiFetchMock.mockResolvedValue({ priority: null })
    renderFeed({ events: [passiveOnly({ billPriority: 'high' })], total: 1 })
    fireEvent.change(sel(), { target: { value: '__none__' } })
    await waitFor(() => expectClosedLabel(sel(), 'Set priority'))

    // The server now has no priority on the bill, and newer provider updates on it.
    for (const n of [1, 2]) {
      apiFetchMock.mockResolvedValue({
        events: [passiveOnly({ id: `e-new${n}`, createdAt: `2026-02-01 1${n}:00:00` }), passiveOnly()], total: 2, page: 1, limit: 40,
      })
      await act(async () => { await poll.fn!() })
      expect(screen.getByText('Mail Ballot Rules')).toBeInTheDocument()
      expectClosedLabel(sel(), 'Set priority')
    }
  })

  it('hides a card with no priority and only a provider update when no one edited it', () => {
    renderFeed({ events: [passiveOnly()], total: 1 })
    expect(screen.queryByText('Mail Ballot Rules')).toBeNull()
  })
})
