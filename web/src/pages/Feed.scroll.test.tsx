import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { FeedEvent } from '../lib/feedUtils'

// Record every /feed fetch so we can assert how many pages a single
// scroll-to-bottom pulls in.
const apiCalls: string[] = []

// Each page returns 40 raw events, but only VISIBLE_PER_PAGE of them survive the
// default-scope filter (filterPriorityEvents) — the rest are passive provider
// updates on non-prioritized bills, which the feed hides. This reproduces the
// real-world case where one page of 40 raw events collapses to a couple cards.
const VISIBLE_PER_PAGE = 3
const TOTAL_RAW = 1000

function makeEvent(over: Partial<FeedEvent>): FeedEvent {
  return {
    id: 'x', type: 'bill_updated', billId: 'b', billNumber: 'HB 1',
    billSessionSlug: null, billState: 'RI', billTitle: 'Bill', billSummary: null,
    billPriority: null, billMatchType: null, userId: 'u1', userName: 'U',
    userSubtitle: null, metadata: {}, createdAt: '2026-02-01 10:00:00', ...over,
  }
}

function pageEvents(page: number): FeedEvent[] {
  const out: FeedEvent[] = []
  for (let i = 0; i < 40; i++) {
    const visible = i < VISIBLE_PER_PAGE
    out.push(makeEvent({
      id: `p${page}-e${i}`,
      // distinct billId per event so each becomes its own day-group (card)
      billId: `p${page}-b${i}`,
      // non-passive type → survives filterPriorityEvents; passive → filtered out
      type: visible ? 'priority_set' : 'bill_updated',
    }))
  }
  return out
}

vi.mock('../lib/api', () => ({
  apiFetch: async (path: string) => {
    apiCalls.push(path)
    const page = Number(new URL(path, 'http://x').searchParams.get('page') || 1)
    return { events: pageEvents(page), total: TOTAL_RAW, page, limit: 40 }
  },
  ApiError: class extends Error {},
}))
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import { FeedPane, feedLoader } from './Feed'

// Capturing IntersectionObserver — records the callback so the test can simulate
// the sentinel scrolling into view exactly once.
let intersectCb: ((entries: { isIntersecting: boolean }[]) => void) | null = null
class CapturingIntersectionObserver {
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { intersectCb = cb }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  apiCalls.length = 0
  intersectCb = null
  vi.stubGlobal('IntersectionObserver', CapturingIntersectionObserver)
})
afterEach(() => { vi.unstubAllGlobals() })

const feedCalls = () => apiCalls.filter(c => c.includes('/feed'))

it('auto-fills the initial load and adds a full batch per scroll', async () => {
  const router = createMemoryRouter(
    [{ path: '/', element: <FeedPane />, loader: feedLoader }],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)

  // The initial load must NOT stop at a single thin page — it fills to the
  // visible-card target, so it pulls several pages on its own.
  await waitFor(() => expect(feedCalls().length).toBeGreaterThanOrEqual(2))
  // Wait for the initial fill to settle (loading indicator clears) so the count
  // below reflects a finished initial load, not a mid-flight one.
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
  const afterInitial = feedCalls().length

  // One scroll-to-bottom pulls a fresh batch (~15 visible cards = 5 pages at
  // VISIBLE_PER_PAGE=3) — far more than the old one-page-per-scroll.
  intersectCb!([{ isIntersecting: true }])
  await waitFor(() => expect(feedCalls().length).toBeGreaterThanOrEqual(afterInitial + 5))
})
