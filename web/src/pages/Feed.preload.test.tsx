import { it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

const apiCalls: string[] = []
vi.mock('../lib/api', () => ({
  apiFetch: async (path: string) => { apiCalls.push(path); return { events: [], total: 0, page: 1, limit: 40 } },
  ApiError: class extends Error {},
}))
// FeedUnread + auth contexts are consumed by Feed; stub to no-ops.
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import { Feed } from './Feed'

// FeedEvent shape from shared/feedUtils.ts — all required fields must be present
// so groupEventsByBillAndDay renders the card with billTitle.
// Using type 'priority_set' (non-passive) so filterPriorityEvents passes the group through.
const PRELOADED = {
  events: [{
    id: 'e1',
    type: 'priority_set' as const,
    billId: 'b1',
    billNumber: 'HB 1',
    billTitle: 'Seeded Bill',
    billSessionSlug: null,
    billState: 'RI',
    billSummary: null,
    billPriority: null,
    billMatchType: null as null,
    userId: 'u1',
    userName: 'Test User',
    userSubtitle: null,
    metadata: {},
    createdAt: '2026-02-01 10:00:00',
  }],
  total: 1, page: 1, limit: 40,
}

it('renders the loader-provided feed without a loading flash or a refetch', async () => {
  apiCalls.length = 0
  // The route loader resolves the first page before render (here, directly from
  // the fixture), so Feed seeds from useLoaderData and must not refetch page 1.
  const router = createMemoryRouter(
    [{ path: '/', element: <Feed />, loader: () => PRELOADED }],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  expect(await screen.findByText('Seeded Bill')).toBeInTheDocument()
  expect(screen.queryByText('Loading…')).toBeNull()
  // The page must NOT immediately refetch page 1 when the loader already seeded it.
  expect(apiCalls.some(c => c.startsWith('/feed?page=1'))).toBe(false)
})
