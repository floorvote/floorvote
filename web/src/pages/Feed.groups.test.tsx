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

// A companion group is one policy: one card per group per day, with each event
// labeled by its bill (#381) when the card shows more than one bill.
const base = {
  billSessionSlug: '2026rs', billState: 'RI', billTitle: 'Mail Ballot Processing', billSummary: null, billPriority: 'high',
  billMatchType: 'keyword' as const, userId: 'u2', userName: 'Ada Admin', userTitle: null,
}
const changes = (newValue: string) => ({ changes: [{ changeType: 'action_added', newValue }] })

function renderFeed(events: unknown[]) {
  render(<MemoryRouter><Feed preloaded={{ events, total: events.length, page: 1, limit: 40 } as never} /></MemoryRouter>)
}

it('shows one card for a group\'s events on one day, and one more for another day', () => {
  renderFeed([
    { ...base, id: 'e4', type: 'bill_updated', billId: 's1', billNumber: 'S 202', billGroupKey: 'h1', metadata: changes('Signed'), createdAt: '2026-02-02 10:00:00' },
    { ...base, id: 'e3', type: 'bill_updated', billId: 'h1', billNumber: 'H 101', billGroupKey: 'h1', metadata: changes('Passed House'), createdAt: '2026-02-01 12:00:00' },
    { ...base, id: 'e2', type: 'bill_updated', billId: 's1', billNumber: 'S 202', billGroupKey: 'h1', metadata: changes('Reported'), createdAt: '2026-02-01 11:00:00' },
  ])
  expect(screen.getAllByText('Mail Ballot Processing')).toHaveLength(2)
  expect(screen.getByText('S 202: Action: Reported')).toBeInTheDocument()
  expect(screen.getByText('H 101: Action: Passed House')).toBeInTheDocument()
  // The other day's card has events on one bill only, so its one chip names it.
  expect(screen.getByText('Action: Signed')).toBeInTheDocument()
  expect(screen.queryByText('S 202: Action: Signed')).toBeNull()
})

it('keeps two ungrouped bills\' cards apart and unlabeled', () => {
  renderFeed([
    { ...base, id: 'e2', type: 'bill_updated', billId: 'b2', billNumber: 'HB 2', billTitle: 'Second Bill', billGroupKey: null, metadata: changes('Referred'), createdAt: '2026-02-01 12:00:00' },
    { ...base, id: 'e1', type: 'bill_updated', billId: 'b1', billNumber: 'HB 1', billTitle: 'First Bill', billGroupKey: null, metadata: changes('Referred'), createdAt: '2026-02-01 11:00:00' },
  ])
  expect(screen.getByText('First Bill')).toBeInTheDocument()
  expect(screen.getByText('Second Bill')).toBeInTheDocument()
  expect(screen.queryByText(/^HB \d:/)).toBeNull()
})
