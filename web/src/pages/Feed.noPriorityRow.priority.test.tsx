/**
 * Feed: a card's priority control beside the no-priority updates row (#919, #924)
 *
 * A bill engaged with one day has a card that day, and its update on another
 * day can be in that day's row. Setting its priority from the card updates the
 * card in place and leaves the row as the server last resolved it; the next
 * read takes the bill out of the row and gives its update a card of its own.
 */
import { it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const apiFetchMock = vi.fn()
const poll = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock('../hooks/usePolling', () => ({ usePolling: (fn: () => Promise<void>) => { poll.fn = fn; return { forceRefresh: () => {} } } }))
vi.mock('../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  ApiError: class extends Error {},
}))
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'admin' } }) }))

import { Feed } from './Feed'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import type { FeedEvent } from '../lib/feedUtils'

const base = {
  billSessionSlug: '2026', billState: 'RI', billSummary: null, billPriority: null, billMatchType: 'keyword' as const,
  billGroupKey: null, billNewMatch: false, userTitle: null,
}
const X = { id: 'bx', billNumber: 'HB7', title: 'Ballot Access Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null, summary: null }
const Y = { id: 'by', billNumber: 'SB8', title: 'Canvass Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null, summary: null }

const comment: FeedEvent = {
  ...base, id: 'c1', type: 'comment_added', billId: 'bx', billNumber: 'HB7', billTitle: 'Ballot Access Act',
  userId: 'u2', userName: 'Ada Admin', metadata: { preview: 'Worth a look.' }, createdAt: '2026-03-03 15:00:00',
} as FeedEvent
const row = (count: number, firstBills: unknown[]): FeedEvent => ({
  ...base, billMatchType: null, id: 'row', type: 'no_priority_updates', billId: null, billNumber: '', billTitle: '',
  userId: 'system', userName: '', metadata: { count, firstBills, lastAt: '2026-03-04 15:00:00' }, createdAt: '2026-03-04 12:00:00',
} as FeedEvent)
const xUpdate: FeedEvent = {
  ...base, billPriority: 'high', id: 'u1', type: 'bill_updated', billId: 'bx', billNumber: 'HB7', billTitle: 'Ballot Access Act',
  userId: 'system', userName: '', createdAt: '2026-03-04 14:00:00',
  metadata: { changes: [{ changeType: 'action_added', oldValue: null, newValue: 'Referred to committee', detail: null }] },
} as FeedEvent

beforeEach(() => {
  poll.fn = null
  apiFetchMock.mockReset()
})

it('takes a bill out of the row on the next read once its card sets a priority, never showing it in both', async () => {
  const before = [row(2, [X, Y]), comment]
  render(
    <MemoryRouter>
      <SidebarRefreshProvider>
        <Feed preloaded={{ events: before, total: before.length, page: 1, limit: 40 } as never} />
      </SidebarRefreshProvider>
    </MemoryRouter>,
  )
  const rowToggle = () => screen.getByRole('button', { name: /updates on \d+ bills? with no priority/i })
  expect(rowToggle()).toHaveAccessibleName('Updates on 2 bills with no priority')
  // The row's bills are chips, never cards: the only control is the card's.
  expect(screen.getAllByRole('combobox', { name: /priority/i })).toHaveLength(1)

  apiFetchMock.mockResolvedValue({ priority: 'high', promoted: false })
  fireEvent.change(screen.getByRole('combobox', { name: /priority/i }), { target: { value: 'high' } })
  await waitFor(() => expect((screen.getByRole('combobox', { name: /priority/i }) as HTMLSelectElement).value).toBe('high'))
  // In place, the row stays as the server last resolved it.
  expect(rowToggle()).toHaveAccessibleName('Updates on 2 bills with no priority')

  // The next read: the server resolves the row without the bill, and its update is a card.
  const after = [comment, xUpdate, row(1, [Y])].map((e) => (e.billId === 'bx' ? { ...e, billPriority: 'high' } : e))
  apiFetchMock.mockImplementation(async (url: string) => (url.startsWith('/feed?') ? { events: [{ ...comment, id: 'c2', createdAt: '2026-03-05 09:00:00' }, ...after], total: 4, page: 1, limit: 40 } : undefined))
  await act(async () => { await poll.fn!() })

  await waitFor(() => expect(rowToggle()).toHaveAccessibleName('Updates on 1 bill with no priority'))
  const day = document.querySelector('[data-feed-day="2026-03-04"]') as HTMLElement
  expect(within(day).getByText('Action: Referred to committee')).toBeInTheDocument()
  const header = rowToggle().parentElement as HTMLElement
  expect(within(header).queryByRole('link', { name: 'HB7' })).toBeNull()
  expect(within(header).getByRole('link', { name: 'SB8' })).toBeInTheDocument()
})
