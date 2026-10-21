/**
 * Feed: a lone bill with no priority as a full card (#921)
 *
 * When a day's no-priority updates row resolves to one entry (a bill, or one
 * companion group), GET /feed sends that entry's updates for the day, marked
 * noPriorityCard, and no row. The Feed draws them as the card a prioritized
 * bill gets: header, title, summary, change rows, and an admin's "Set
 * priority" dropdown at the top right. Like the row, the card is passive: it
 * raises no "New activity" banner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
const authMock = vi.fn()
vi.mock('../hooks/useAuth', () => ({ useAuth: () => authMock() }))

import { Feed } from './Feed'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import type { FeedEvent } from '../lib/feedUtils'
import { expectClosedLabel } from '../test/closedLabel'

const base = {
  billSessionSlug: '2026', billState: 'RI', billSummary: null, billPriority: null, billMatchType: 'keyword' as const,
  billGroupKey: null, billNewMatch: false, billIsDraft: false, userTitle: null,
}
const changes = (newValue: string) => ({ changes: [{ changeType: 'action_added', oldValue: null, newValue, detail: null }] })
/** One of the lone bill's updates, as GET /feed sends it. */
const lone = (id: string, over: Partial<FeedEvent> & { newValue?: string } = {}): FeedEvent => {
  const { newValue = 'Referred to committee', ...rest } = over
  return {
    ...base, id, type: 'bill_updated', billId: 'b1', billNumber: 'HB7', billTitle: 'Ballot Access Act',
    billSummary: 'Moves the filing deadline.', userId: 'system', userName: '', metadata: changes(newValue),
    createdAt: '2026-03-04 14:00:00', noPriorityCard: true, ...rest,
  } as FeedEvent
}
const comment = (id: string, createdAt: string): FeedEvent => ({
  ...base, id, type: 'comment_added', billId: 'p1', billNumber: 'HB900', billTitle: 'Prioritized Act', billPriority: 'high',
  userId: 'u2', userName: 'Ada Admin', metadata: { preview: 'Worth a look.' }, createdAt,
} as FeedEvent)
const row = (count: number, createdAt: string, lastAt: string): FeedEvent => ({
  ...base, billMatchType: null, id: 'row', type: 'no_priority_updates', billId: null, billNumber: '', billTitle: '',
  userId: 'system', userName: '', createdAt,
  metadata: {
    count, lastAt,
    firstBills: [
      { id: 'x1', billNumber: 'SB1', title: 'First Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null, summary: null },
      { id: 'x2', billNumber: 'SB2', title: 'Second Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null, summary: null },
    ],
  },
} as FeedEvent)

function renderFeed(events: FeedEvent[]) {
  return render(
    <MemoryRouter>
      <SidebarRefreshProvider>
        <Feed preloaded={{ events, total: events.length, page: 1, limit: 40 } as never} />
      </SidebarRefreshProvider>
    </MemoryRouter>,
  )
}
const selects = () => screen.queryAllByRole('combobox', { name: /priority/i })
const rowToggle = () => screen.queryByRole('button', { name: /updates on \d+ bills? with no priority/i })
const asAdmin = () => authMock.mockReturnValue({ user: { id: 'u1', role: 'admin' } })
const asMember = () => authMock.mockReturnValue({ user: { id: 'u1', role: 'member' } })

beforeEach(() => {
  poll.fn = null
  apiFetchMock.mockReset()
  asAdmin()
})

describe('the lone bill\'s card', () => {
  it('draws the bill\'s full card: its title, summary, and each change row, with no row', () => {
    renderFeed([lone('u2', { createdAt: '2026-03-04 15:00:00', newValue: 'Hearing held' }), lone('u1')])
    expect(screen.getByText('Ballot Access Act')).toBeInTheDocument()
    expect(screen.getByText('Moves the filing deadline.')).toBeInTheDocument()
    expect(screen.getByText('Action: Hearing held')).toBeInTheDocument()
    expect(screen.getByText('Action: Referred to committee')).toBeInTheDocument()
    expect(rowToggle()).toBeNull()
  })

  it('gives an admin the "Set priority" dropdown at its top right', () => {
    renderFeed([lone('u1')])
    expect(selects()).toHaveLength(1)
    expect((selects()[0] as HTMLSelectElement).value).toBe('__none__')
    expectClosedLabel(selects()[0], 'Set priority')
  })

  it('gives an untriaged new match the amber "New · Set priority"', () => {
    renderFeed([lone('u1', { billNewMatch: true })])
    expect(selects()).toHaveLength(1)
    expectClosedLabel(selects()[0], 'New · Set priority')
  })

  it('shows a member the card read-only, with no dropdown', () => {
    asMember()
    renderFeed([lone('u1')])
    expect(screen.getByText('Ballot Access Act')).toBeInTheDocument()
    expect(screen.getByText('Action: Referred to committee')).toBeInTheDocument()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })

  it('shows a member a new match\'s read-only "New match" label', () => {
    asMember()
    renderFeed([lone('u1', { billNewMatch: true })])
    expect(screen.getByText('New match')).toBeInTheDocument()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })

  it('draws a companion group alone on a day as one card naming both members', () => {
    renderFeed([
      lone('u2', { billId: 'b2', billNumber: 'SB8', billGroupKey: 'b1', createdAt: '2026-03-04 15:00:00', newValue: 'Reported favorably' }),
      lone('u1', { billGroupKey: 'b1' }),
    ])
    expect(selects()).toHaveLength(1)
    // A group's card names each row's bill beside its change.
    expect(screen.getByText(/Reported favorably/)).toBeInTheDocument()
    expect(screen.getByText(/Referred to committee/)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /SB8/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: /HB7/ }).length).toBeGreaterThan(0)
  })

  it('keeps hiding a no-priority bill\'s updates the server did not send as its card', () => {
    renderFeed([lone('u1', { noPriorityCard: false }), comment('c1', '2026-03-04 10:00:00')])
    expect(screen.queryByText('Ballot Access Act')).toBeNull()
    expect(screen.getByText('Prioritized Act')).toBeInTheDocument()
  })

  it('sits beside a row of another day, each drawn its own way', () => {
    renderFeed([row(2, '2026-03-05 12:00:00', '2026-03-05 15:00:00'), lone('u1')])
    expect(rowToggle()).toHaveAccessibleName('Updates on 2 bills with no priority')
    expect(screen.getByText('Ballot Access Act')).toBeInTheDocument()
  })

  it('updates in place when an admin sets its priority from the card, and stays', async () => {
    renderFeed([lone('u1')])
    expect(selects()).toHaveLength(1)
    apiFetchMock.mockResolvedValue({ priority: 'high', promoted: false })
    fireEvent.change(selects()[0], { target: { value: 'high' } })
    await waitFor(() => expect((selects()[0] as HTMLSelectElement).value).toBe('high'))
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1/priority', expect.objectContaining({ method: 'PATCH' }))
    expect(screen.getByText('Ballot Access Act')).toBeInTheDocument()
  })
})

describe('the poll, with a lone card newer than anything else', () => {
  let main: HTMLElement | null = null
  const scrolledTo = (top: number) => {
    main = document.createElement('main')
    main.className = 'app-main'
    document.body.appendChild(main)
    Object.defineProperty(main, 'scrollTop', { configurable: true, get: () => top, set: () => {} })
  }
  afterEach(() => { main?.remove(); main = null })

  it('raises no "New activity" banner when the reader has scrolled down', async () => {
    renderFeed([comment('c1', '2026-03-04 10:00:00')])
    scrolledTo(600)
    apiFetchMock.mockResolvedValue({ events: [lone('u1', { createdAt: '2026-03-04 18:00:00' }), comment('c1', '2026-03-04 10:00:00')], total: 2, page: 1, limit: 40 })
    await act(async () => { await poll.fn!() })
    expect(screen.queryByRole('button', { name: /new activity/i })).toBeNull()
  })

  it('loads nothing in place at the top of the feed', async () => {
    // Two cards on screen; the poll's page holds only the newer one and the lone card.
    renderFeed([comment('c1', '2026-03-04 10:00:00'), { ...comment('c0', '2026-03-03 10:00:00'), billId: 'p2', billNumber: 'HB901', billTitle: 'Older Act' }])
    scrolledTo(0)
    apiFetchMock.mockResolvedValue({ events: [lone('u1', { createdAt: '2026-03-04 18:00:00' }), comment('c1', '2026-03-04 10:00:00')], total: 2, page: 1, limit: 40 })
    await act(async () => { await poll.fn!() })
    // A load in place would have swapped the feed for the poll's page.
    expect(screen.getByText('Older Act')).toBeInTheDocument()
    expect(screen.queryByText('Ballot Access Act')).toBeNull()
    expect(screen.queryByRole('button', { name: /new activity/i })).toBeNull()
  })

  it('still raises the banner for the team\'s new activity beside it', async () => {
    renderFeed([comment('c1', '2026-03-04 10:00:00')])
    scrolledTo(600)
    apiFetchMock.mockResolvedValue({ events: [lone('u1', { createdAt: '2026-03-04 18:00:00' }), comment('c2', '2026-03-04 17:00:00'), comment('c1', '2026-03-04 10:00:00')], total: 3, page: 1, limit: 40 })
    await act(async () => { await poll.fn!() })
    expect(screen.getByRole('button', { name: /new activity/i })).toBeInTheDocument()
  })
})

// The server decides lone-ness by the UTC day, as it does the row; the Feed files
// the card like any bill card, under the viewer's day of its updates.
describe('the card\'s day', () => {
  const originalTz = process.env.TZ
  beforeEach(() => { process.env.TZ = 'America/New_York' })
  afterEach(() => { process.env.TZ = originalTz })
  const dayOf = (el: Element) => (el.closest('[data-feed-day]') as HTMLElement | null)?.dataset.feedDay

  it('files updates from early on the 5th, UTC, under the evening of the 4th in New York', () => {
    renderFeed([
      comment('c5', '2026-03-05 15:00:00'),
      lone('u1', { createdAt: '2026-03-05 01:30:00' }),
      comment('c4', '2026-03-04 20:00:00'),
    ])
    expect(dayOf(screen.getByText('Ballot Access Act'))).toBe('2026-03-04')
  })

  it('files them on the same day as the row of the UTC day before, as the viewer sees both', () => {
    // The row stands for the 4th's other updates, its newest on the afternoon of the 4th.
    renderFeed([
      lone('u1', { createdAt: '2026-03-05 01:30:00' }),
      row(2, '2026-03-04 06:00:00', '2026-03-04 18:00:00'),
    ])
    expect(dayOf(screen.getByText('Ballot Access Act'))).toBe('2026-03-04')
    expect(dayOf(rowToggle()!)).toBe('2026-03-04')
  })
})
