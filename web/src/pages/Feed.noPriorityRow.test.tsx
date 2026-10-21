import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { FeedEvent } from '../lib/feedUtils'

// The no-priority updates row (#919): the feed's one row a day for legislative
// activity on analyzed bills with no priority. GET /feed resolves its bills and
// sends their count and the first two; the rest load on expand, a page at a time.

const hoisted = vi.hoisted(() => ({
  poll: null as null | (() => Promise<void>),
  feed: { events: [] as unknown[], total: 0, page: 1, limit: 40 },
  pages: new Map<number, unknown>(),
  failPages: new Set<number>(),
  calls: [] as string[],
}))

vi.mock('../hooks/usePolling', () => ({ usePolling: (fn: () => Promise<void>) => { hoisted.poll = fn } }))
vi.mock('../lib/api', () => ({
  apiFetch: async (url: string) => {
    hoisted.calls.push(url)
    const list = url.match(/^\/feed\/events\/([^/]+)\/bills\?page=(\d+)$/)
    if (list) {
      const page = Number(list[2])
      if (hoisted.failPages.has(page)) throw new Error('network')
      return hoisted.pages.get(page)
    }
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

type Bill = { id: string; billNumber: string; title: string; state: string | null; sessionSlug: string | null; isDraft: boolean; groupKey: string | null; summary: string | null }
const bill = (id: string, billNumber: string, more: Partial<Bill> = {}): Bill => ({
  id, billNumber, title: `Act on ${billNumber}`, state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null, summary: null, ...more,
})
const base = {
  billNumber: '', billTitle: '', billSessionSlug: null, billState: null, billSummary: null, billPriority: null,
  billMatchType: null, userTitle: null,
}
const row = (count: number, firstBills: Bill[], createdAt = '2026-03-04 06:00:00'): FeedEvent => ({
  ...base, id: 'row', type: 'no_priority_updates', billId: null, userId: 'system', userName: '',
  metadata: { count, firstBills }, createdAt,
})
const comment = (id: string, createdAt: string): FeedEvent => ({
  ...base, id, type: 'comment_added', billId: 'p1', billNumber: 'HB 900', billTitle: 'Prioritized Act', billPriority: 'high',
  billMatchType: 'keyword', userId: 'u2', userName: 'Ada Admin', metadata: { preview: 'Worth a look.' }, createdAt,
})
const action = (id: string, billId: string, newValue: string, createdAt = '2026-03-04 09:00:00') => ({
  id, type: 'bill_updated', billId, createdAt, metadata: { changes: [{ changeType: 'action_added', oldValue: null, newValue, detail: null }] },
})
const entry = (b: Bill[], events: unknown[]) => ({ key: b[0].groupKey ? `group:${b[0].groupKey}` : b[0].id, bills: b, events })

function showFeed(events: FeedEvent[]) {
  hoisted.feed = { events, total: events.length, page: 1, limit: 40 }
  return render(
    <MemoryRouter>
      <Feed preloaded={hoisted.feed as never} />
    </MemoryRouter>,
  )
}
const toggle = () => screen.getByRole('button', { name: /updates on \d+ bills? with no priority/i })
const box = () => document.querySelector('[data-feed-bill-list]') as HTMLElement

beforeEach(() => {
  hoisted.poll = null
  hoisted.pages = new Map()
  hoisted.failPages = new Set()
  hoisted.calls = []
})

describe('the collapsed row', () => {
  it('reads "Updates on N bills with no priority", then two chips and "+(N-2)"', () => {
    showFeed([row(9, [bill('b1', 'HB2'), bill('b2', 'SB5')])])
    expect(toggle()).toHaveAccessibleName('Updates on 9 bills with no priority')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('link', { name: 'HB2' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SB5' })).toBeInTheDocument()
    expect(screen.getByText('+7')).toBeInTheDocument()
  })

  it('links each chip to its bill page', () => {
    showFeed([row(3, [bill('b1', 'HB2'), bill('b2', 'SB5', { state: 'RI', sessionSlug: '2025' })])])
    expect(screen.getByRole('link', { name: 'HB2' })).toHaveAttribute('href', '/RI/2026/HB2')
    expect(screen.getByRole('link', { name: 'SB5' })).toHaveAttribute('href', '/RI/2025/SB5')
  })

  it('shows the sidebar\'s hover card for a chip', async () => {
    showFeed([row(2, [bill('b1', 'HB2', { title: 'Ballot Access Act', summary: 'Moves the filing deadline.' }), bill('b2', 'SB5')])])
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'HB2' }), { clientX: 100, clientY: 100 })
    expect(await screen.findByText('Ballot Access Act')).toBeInTheDocument()
    expect(screen.getByText('Moves the filing deadline.')).toBeInTheDocument()
  })

  it('shows no "+N" for two bills', () => {
    showFeed([row(2, [bill('b1', 'HB2'), bill('b2', 'SB5')])])
    expect(toggle()).toHaveAccessibleName('Updates on 2 bills with no priority')
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
  })

  it('reads as one bill, with one chip, for a day with one', () => {
    showFeed([row(1, [bill('b1', 'HB2')])])
    expect(toggle()).toHaveAccessibleName('Updates on 1 bill with no priority')
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('shows no time: the date divider says the day', () => {
    showFeed([row(3, [bill('b1', 'HB2'), bill('b2', 'SB5')], '2026-03-04 06:00:00')])
    const card = toggle().closest('[data-no-priority-row]') as HTMLElement
    expect(card).not.toBeNull()
    expect(within(card).queryByText(/ago|AM|PM|\d+:\d\d/)).toBeNull()
  })

  it('is not a bill card, and fetches nothing until expanded', () => {
    showFeed([row(3, [bill('b1', 'HB2'), bill('b2', 'SB5')])])
    expect(toggle()).toBeInTheDocument()
    expect(screen.queryByText('Act on HB2')).toBeNull()
    expect(hoisted.calls).toEqual([])
  })
})

describe('the expanded list', () => {
  const HB2 = bill('b1', 'HB2', { title: 'Ballot Access Act' })
  const SB5 = bill('b2', 'SB5', { groupKey: 'b2' })
  const HB6 = bill('b3', 'HB6', { groupKey: 'b2' })
  const PAGE1 = {
    entries: [
      entry([HB2], [
        { id: 'h1', type: 'hearing_added', billId: 'b1', createdAt: '2026-03-04 11:00:00', metadata: { date: '2026-03-10', time: null, location: 'Room 2', description: 'Elections Committee' } },
        action('u1', 'b1', 'Passed second reading', '2026-03-04 10:00:00'),
      ]),
      entry([SB5, HB6], [action('u2', 'b2', 'Referred to committee'), action('u3', 'b3', 'Reported favorably')]),
    ],
    total: 3, page: 1, limit: 50, hasMore: true,
  }
  const PAGE2 = { entries: [entry([bill('b4', 'HB9')], [action('u4', 'b4', 'Introduced')])], total: 3, page: 2, limit: 50, hasMore: false }

  async function expand() {
    hoisted.pages.set(1, PAGE1)
    hoisted.pages.set(2, PAGE2)
    showFeed([row(3, [HB2, SB5])])
    await userEvent.click(toggle())
    await screen.findByRole('link', { name: 'Ballot Access Act' })
  }

  it('loads the first page on expand, and lists each entry with its chip, its serif title linking to the bill, and its changes that day', async () => {
    await expand()
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(hoisted.calls).toEqual(['/feed/events/row/bills?page=1'])
    const title = screen.getByRole('link', { name: 'Ballot Access Act' })
    expect(title).toHaveAttribute('href', '/RI/2026/HB2')
    expect(title.style.fontFamily).toContain('Source Serif 4')
    const first = title.closest('[data-bill-entry]') as HTMLElement
    expect(within(first).getByRole('link', { name: 'HB2' })).toHaveAttribute('href', '/RI/2026/HB2')
    expect(within(first).getByText('Action: Passed second reading')).toBeInTheDocument()
    expect(within(first).getByText(/^Hearing scheduled: 2026-03-10 · Room 2 · Elections Committee$/)).toBeInTheDocument()
    // The same icons as a card's rows.
    expect(within(first).getByText('arrow_forward')).toBeInTheDocument()
    expect(within(first).getByText('gavel')).toBeInTheDocument()
  })

  it('lists a companion group as one entry, a chip for each member, each change labeled with its bill', async () => {
    await expand()
    const entries = box().querySelectorAll('[data-bill-entry]')
    expect(entries).toHaveLength(2)
    const group = entries[1] as HTMLElement
    expect(within(group).getByRole('link', { name: 'SB5' })).toBeInTheDocument()
    expect(within(group).getByRole('link', { name: 'HB6' })).toBeInTheDocument()
    expect(within(group).getByText('SB5: Action: Referred to committee')).toBeInTheDocument()
    expect(within(group).getByText('HB6: Action: Reported favorably')).toBeInTheDocument()
  })

  it('loads the next page when the 300px box is scrolled to its end, and stops at the last', async () => {
    await expand()
    expect(box().style.maxHeight).toBe('300px')
    Object.defineProperty(box(), 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(box(), 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(box(), 'scrollTop', { configurable: true, value: 100, writable: true })
    fireEvent.scroll(box())
    expect(hoisted.calls).toEqual(['/feed/events/row/bills?page=1'])

    box().scrollTop = 700
    fireEvent.scroll(box())
    expect(await screen.findByRole('link', { name: 'Act on HB9' })).toBeInTheDocument()
    expect(hoisted.calls).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2'])

    fireEvent.scroll(box())
    await act(async () => {})
    expect(hoisted.calls).toHaveLength(2)
  })

  it('resizes the box with its drag handle', async () => {
    await expand()
    const handle = box().parentElement!.querySelector('[style*="ns-resize"]') as HTMLElement
    expect(handle).not.toBeNull()
    fireEvent.pointerDown(handle, { clientY: 100 })
    act(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientY: 250, bubbles: true })) })
    act(() => { document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })) })
    expect(box().style.maxHeight).toBe('450px')
  })

  it('collapses and re-expands from what it has', async () => {
    await expand()
    await userEvent.click(toggle())
    expect(screen.queryByRole('link', { name: 'Ballot Access Act' })).toBeNull()
    await userEvent.click(toggle())
    expect(screen.getByRole('link', { name: 'Ballot Access Act' })).toBeInTheDocument()
    expect(hoisted.calls).toEqual(['/feed/events/row/bills?page=1'])
  })

  it('shows the retry note when the first page fails, and loads it on retry', async () => {
    hoisted.failPages.add(1)
    hoisted.pages.set(1, PAGE1)
    showFeed([row(3, [HB2, SB5])])
    await userEvent.click(toggle())
    expect(await screen.findByText(/Couldn’t load the bills\./)).toBeInTheDocument()

    hoisted.failPages.clear()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Ballot Access Act' })).toBeInTheDocument()
    expect(screen.queryByText(/Couldn’t load the bills\./)).toBeNull()
  })

  it('shows the retry note when a later page fails, keeping what it has', async () => {
    await expand()
    hoisted.failPages.add(2)
    Object.defineProperty(box(), 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(box(), 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(box(), 'scrollTop', { configurable: true, value: 700 })
    fireEvent.scroll(box())
    expect(await screen.findByText(/Couldn’t load the bills\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ballot Access Act' })).toBeInTheDocument()

    hoisted.failPages.clear()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Act on HB9' })).toBeInTheDocument()
  })
})

describe('around the row', () => {
  it('shows no row for a day with no qualifying bills', () => {
    showFeed([row(0, []), comment('c1', '2026-03-04 10:00:00')])
    expect(screen.queryByText(/with no priority/i)).toBeNull()
    expect(screen.getByText('Prioritized Act')).toBeInTheDocument()
  })

  it('leaves a day with only team activity as it was', () => {
    showFeed([comment('c1', '2026-03-04 10:00:00')])
    expect(screen.queryByText(/with no priority/i)).toBeNull()
    expect(screen.getByText('Prioritized Act')).toBeInTheDocument()
    expect(screen.getByText(/Worth a look\./)).toBeInTheDocument()
  })

  it('sits in the day beside the team\'s cards, in time order', () => {
    showFeed([comment('c1', '2026-03-04 10:00:00'), row(3, [bill('b1', 'HB2'), bill('b2', 'SB5')], '2026-03-04 06:00:00')])
    const card = screen.getByText('Prioritized Act')
    expect(card.compareDocumentPosition(toggle()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('still draws a bulk edit as its activity row', () => {
    showFeed([{
      ...base, id: 'bulk', type: 'priority_set', billId: null, userId: 'u2', userName: 'Ada Admin',
      metadata: { priority: 'high', count: 4, billIds: ['b1'] }, createdAt: '2026-03-04 12:00:00',
    }, row(3, [bill('b1', 'HB2'), bill('b2', 'SB5')])])
    expect(screen.getByText('Ada Admin set priority to high on 4 bills')).toBeInTheDocument()
    expect(toggle()).toBeInTheDocument()
  })

  it('never raises the new-activity banner by itself', async () => {
    showFeed([comment('c1', '2026-03-04 10:00:00')])
    const main = document.createElement('main')
    main.className = 'app-main'
    document.body.appendChild(main)
    Object.defineProperty(main, 'scrollTop', { configurable: true, get: () => 600, set: () => {} })
    hoisted.feed = { events: [row(2, [bill('b1', 'HB2'), bill('b2', 'SB5')], '2026-03-05 06:00:00'), comment('c1', '2026-03-04 10:00:00')], total: 2, page: 1, limit: 40 }
    await act(async () => { await hoisted.poll!() })
    expect(screen.queryByRole('button', { name: /new activity/i })).toBeNull()
    main.remove()
  })
})

// Guard for the tests above: the scroll box is found by its data attribute.
it('marks the list\'s scroll box for the tests', async () => {
  hoisted.pages.set(1, { entries: [], total: 0, page: 1, limit: 50, hasMore: false })
  showFeed([row(2, [bill('b1', 'HB2'), bill('b2', 'SB5')])])
  await userEvent.click(toggle())
  await waitFor(() => expect(box()).not.toBeNull())
})
