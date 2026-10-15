import { it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/api', () => ({
  apiFetch: async () => ({ events: [], total: 0, page: 1, limit: 40 }),
  ApiError: class extends Error {},
}))
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import { Feed } from './Feed'

const base = {
  billSessionSlug: null, billState: null, billSummary: null, billPriority: null, billMatchType: null as null,
  userId: 'u2', userName: 'Ada Admin', userSubtitle: null,
}

// A bulk edit is one bill-less event. It sits in the same Feed as per-bill cards:
// as its own activity row, not folded into any bill's card.
it('renders a bill-less event as an activity row beside per-bill cards', () => {
  const events = [
    {
      ...base, id: 'bulk', type: 'priority_set' as const, billId: null, billNumber: '', billTitle: '',
      metadata: { priority: 'high', count: 34, billIds: ['b1'] }, createdAt: '2026-02-01 11:00:00',
    },
    {
      ...base, id: 'c1', type: 'comment_added' as const, billId: 'b9', billNumber: 'HB 9', billTitle: 'Other Bill',
      metadata: { preview: 'hello' }, createdAt: '2026-02-01 10:00:00',
    },
  ]
  render(
    <MemoryRouter>
      <Feed preloaded={{ events, total: 2, page: 1, limit: 40 } as never} />
    </MemoryRouter>,
  )
  expect(screen.getByText('Ada Admin set priority to high on 34 bills')).toBeInTheDocument()
  expect(screen.getByText('Other Bill')).toBeInTheDocument()
  // The bulk event is not a card headed by some bill.
  expect(screen.getAllByText('HB 9')).toHaveLength(1)
})
