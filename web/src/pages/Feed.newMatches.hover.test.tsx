import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { FeedEvent } from '../lib/feedUtils'

// The new-matches row on the Feed page (#923): expanded, its chips carry the
// sidebar's hover card, as the no-priority row's do, and a bulk edit beside it
// gets the same list.

const hoisted = vi.hoisted(() => ({
  feed: { events: [] as unknown[], total: 0, page: 1, limit: 40 },
  lists: new Map<string, unknown>(),
  calls: [] as string[],
}))

vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../lib/api', () => ({
  apiFetch: async (url: string) => {
    hoisted.calls.push(url)
    const list = url.match(/^\/feed\/events\/([^/]+)\/bills$/)
    if (list) return hoisted.lists.get(list[1])
    if (url.startsWith('/feed?')) return hoisted.feed
    throw new Error(`unexpected ${url}`)
  },
  ApiError: class extends Error {},
}))
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import { Feed } from './Feed'

const base = {
  billNumber: '', billTitle: '', billSessionSlug: null, billState: null, billSummary: null, billPriority: null,
  billMatchType: null, userTitle: null,
}
const matches = (billIds: string[]): FeedEvent => ({
  ...base, id: 'nm', type: 'new_matches', billId: null, userId: 'system', userName: '', metadata: { billIds }, createdAt: '2026-03-04 06:00:00',
})
const bulkEdit = (billIds: string[]): FeedEvent => ({
  ...base, id: 'be', type: 'priority_set', billId: null, userId: 'u2', userName: 'Ada Admin',
  metadata: { priority: 'high', count: billIds.length, billIds }, createdAt: '2026-03-03 06:00:00',
})
const listed = (id: string, billNumber: string, more: Record<string, unknown> = {}) => ({
  id, billNumber, title: `Sample Act ${id}`, state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null, summary: null, priority: null, ...more,
})

function showFeed(events: FeedEvent[]) {
  hoisted.feed = { events, total: events.length, page: 1, limit: 40 }
  return render(
    <MemoryRouter>
      <Feed preloaded={hoisted.feed as never} />
    </MemoryRouter>,
  )
}

describe('Feed: the new-matches row\'s expanded list', () => {
  beforeEach(() => { hoisted.lists.clear(); hoisted.calls.length = 0 })

  it('shows the hover card for a chip, with its summary and priority', async () => {
    hoisted.lists.set('nm', { bills: [listed('b1', 'HB2', { summary: 'Moves the filing deadline.', priority: 'medium' }), listed('b2', 'SB5')] })
    showFeed([matches(['b1', 'b2'])])
    await userEvent.click(screen.getByRole('button', { name: /2 new bills matched/ }))
    fireEvent.mouseEnter(await screen.findByRole('link', { name: 'HB2' }), { clientX: 100, clientY: 100 })
    expect(await screen.findByText('Moves the filing deadline.')).toBeInTheDocument()
    expect(screen.getByText('Medium priority')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SB5' })).toHaveAttribute('href', '/RI/2026/SB5')
    expect(screen.getByRole('link', { name: /see all new matches/i })).toHaveAttribute('href', '/bills?newMatches=1')
  })

  it('gives a bulk edit on the same page the same list, with no "See all new matches"', async () => {
    hoisted.lists.set('nm', { bills: [listed('b1', 'HB2')] })
    hoisted.lists.set('be', { bills: [listed('b3', 'HB9', { summary: 'A bulk-edited bill.', priority: 'high' })] })
    showFeed([matches(['b1']), bulkEdit(['b3'])])
    await userEvent.click(screen.getByRole('button', { name: /1 bill\b.*high|high.*1 bill/i }))
    fireEvent.mouseEnter(await screen.findByRole('link', { name: 'HB9' }), { clientX: 100, clientY: 100 })
    expect(await screen.findByText('A bulk-edited bill.')).toBeInTheDocument()
    expect(screen.getByText('High priority')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /see all new matches/i })).not.toBeInTheDocument()
    expect(hoisted.calls).toContain('/feed/events/be/bills')
    expect(hoisted.calls).not.toContain('/feed/events/nm/bills')
  })
})
