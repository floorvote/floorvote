import { it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { FeedEvent } from '../lib/feedUtils'

// The feed polls for new activity. Near the top of the page it loads it in
// place; scrolled down, it shows a banner instead, so the list doesn't shift
// under the reader. "Scrolled" means the app's scroll container, <main
// class="app-main">, not the window, which never scrolls.

function makeEvent(id: string, billNumber: string): FeedEvent {
  return {
    id, type: 'priority_set', billId: `bill-${id}`, billNumber,
    billSessionSlug: null, billState: 'RI', billTitle: `Bill ${billNumber}`, billSummary: null,
    billPriority: null, billMatchType: null, userId: 'u1', userName: 'U',
    userTitle: null, metadata: {}, createdAt: '2026-02-01 10:00:00',
  }
}

const hoisted = vi.hoisted(() => ({
  poll: null as null | (() => Promise<void>),
  events: [] as FeedEvent[],
}))

vi.mock('../hooks/usePolling', () => ({
  usePolling: (fn: () => Promise<void>) => { hoisted.poll = fn },
}))
vi.mock('../lib/api', () => ({
  apiFetch: async () => ({ events: hoisted.events, total: hoisted.events.length, page: 1, limit: 40 }),
  ApiError: class extends Error {},
}))
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import { FeedPane, feedLoader } from './Feed'

beforeEach(() => {
  hoisted.poll = null
  hoisted.events = [makeEvent('e1', 'HB 1')]
})

/** Render the feed inside the app's scroll container, scrolled to `scrollTop`. */
async function renderFeedScrolledTo(scrollTop: number) {
  const router = createMemoryRouter(
    [{ path: '/', element: <main className="app-main"><FeedPane /></main>, loader: feedLoader }],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  await screen.findAllByText(/HB 1/)
  // jsdom has no layout; pin main's scroll offset (Feed resets it on mount).
  const main = document.querySelector('main.app-main') as HTMLElement
  Object.defineProperty(main, 'scrollTop', { configurable: true, get: () => scrollTop, set: () => {} })
  hoisted.events = [makeEvent('e2', 'HB 2'), makeEvent('e1', 'HB 1')]
  await act(async () => { await hoisted.poll!() })
}

it('shows the new-activity banner, and leaves the list alone, when the reader has scrolled main down', async () => {
  await renderFeedScrolledTo(600)
  expect(screen.getByRole('button', { name: /new activity/i })).toBeInTheDocument()
  expect(screen.queryAllByText(/HB 2/)).toHaveLength(0)
})

it('loads new activity in place, with no banner, when main is near the top', async () => {
  await renderFeedScrolledTo(40)
  await waitFor(() => expect(screen.queryAllByText(/HB 2/).length).toBeGreaterThan(0))
  expect(screen.queryByRole('button', { name: /new activity/i })).toBeNull()
})
