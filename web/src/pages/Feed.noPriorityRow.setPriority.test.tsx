/**
 * Feed: setting a priority from the no-priority updates row (#920)
 *
 * An admin sees the priority dropdown on each bill of the expanded row. Choosing
 * a priority saves it, takes the bill out of the list at once, and lowers the
 * row's count and chips in place, with no refetch of the feed; the next read of
 * the feed gives the bill a card of its own. A member sees the read-only label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'

const hoisted = vi.hoisted(() => ({
  poll: null as null | (() => Promise<void>),
  feed: { events: [] as unknown[], total: 0, page: 1, limit: 40 },
  pages: new Map<number, unknown>(),
  calls: [] as string[],
  patches: [] as Array<{ url: string; body: unknown }>,
  // URLs of PATCHes that fail.
  failing: new Set<string>(),
  // List pages held until a test releases them, and a way to answer one by the `removed` it was asked with.
  held: new Map<number, Promise<void>>(),
  respond: null as null | ((page: number, removed: number) => unknown),
}))

vi.mock('../hooks/usePolling', () => ({ usePolling: (fn: () => Promise<void>) => { hoisted.poll = fn; return { forceRefresh: () => {} } } }))
vi.mock('../lib/api', () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    hoisted.calls.push(url)
    if (init?.method === 'PATCH') {
      hoisted.patches.push({ url, body: init.body ? JSON.parse(init.body) : undefined })
      if (hoisted.failing.has(url)) throw new Error('network')
      return url.endsWith('/priority') ? { priority: JSON.parse(init.body!).priority, promoted: false } : { ok: true }
    }
    const list = url.match(/^\/feed\/events\/([^/]+)\/bills\?page=(\d+)(?:&removed=(\d+))?$/)
    if (list) {
      const page = Number(list[2])
      await hoisted.held.get(page)
      return hoisted.respond?.(page, Number(list[3] ?? 0)) ?? hoisted.pages.get(page)
    }
    if (url.startsWith('/feed?')) return hoisted.feed
    throw new Error(`unexpected ${url}`)
  },
  ApiError: class extends Error {},
}))
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
const authMock = vi.fn()
vi.mock('../hooks/useAuth', () => ({ useAuth: () => authMock() }))

import { Feed } from './Feed'
import { SidebarRefreshProvider, useRegisterSidebarRefresh } from '../context/SidebarRefreshContext'
import { expectAmber, expectNotAmber } from '../test/amberStyle'
import { expectClosedLabel } from '../test/closedLabel'
import type { FeedEvent } from '../lib/feedUtils'

type Bill = { id: string; billNumber: string; title: string; state: string | null; sessionSlug: string | null; isDraft: boolean; groupKey: string | null; summary: string | null }
const bill = (id: string, billNumber: string, more: Partial<Bill> = {}): Bill => ({
  id, billNumber, title: `Act on ${billNumber}`, state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null, summary: null, ...more,
})
const base = {
  billNumber: '', billTitle: '', billSessionSlug: null, billState: null, billSummary: null, billPriority: null,
  billMatchType: null, billGroupKey: null, billNewMatch: false, userTitle: null,
}
const row = (count: number, firstBills: Bill[]): FeedEvent => ({
  ...base, id: 'row', type: 'no_priority_updates', billId: null, userId: 'system', userName: '',
  metadata: { count, firstBills }, createdAt: '2026-03-04 06:00:00',
} as FeedEvent)
const action = (id: string, billId: string, newValue = 'Referred to committee') => ({
  id, type: 'bill_updated', billId, createdAt: '2026-03-04 09:00:00',
  metadata: { changes: [{ changeType: 'action_added', oldValue: null, newValue, detail: null }] },
})
const entry = (bills: Bill[], more: { newMatch?: boolean } = {}) => ({
  key: bills[0].groupKey ? `group:${bills[0].groupKey}` : bills[0].id,
  newMatch: more.newMatch ?? false,
  bills,
  events: bills.map((b) => action(`ev-${b.id}`, b.id)),
})
const page = (entries: unknown[], hasMore = false) => ({ entries, total: entries.length, page: 1, limit: 50, hasMore })

const A = bill('ba', 'HB1')
const B = bill('bb', 'HB2')
const C = bill('bc', 'HB3')
const D = bill('bd', 'HB4')
const E = bill('be', 'HB5')

const refreshSidebar = vi.fn()
function Registrar() { useRegisterSidebarRefresh(refreshSidebar); return null }
function Where() { return <div data-testid="where">{useLocation().pathname}</div> }

function showFeed(events: FeedEvent[]) {
  hoisted.feed = { events, total: events.length, page: 1, limit: 40 }
  return render(
    <MemoryRouter>
      <SidebarRefreshProvider>
        <Registrar />
        <Where />
        <Feed preloaded={hoisted.feed as never} />
      </SidebarRefreshProvider>
    </MemoryRouter>,
  )
}
// The first (newest day's) row, when a test shows more than one.
const toggle = () => screen.getAllByRole('button', { name: /updates on \d+ bills? with no priority/i })[0]
const entryOf = (title: string) => screen.getByRole('link', { name: title }).closest('[data-bill-entry]') as HTMLElement
const selectIn = (el: HTMLElement) => within(el).getByRole('combobox', { name: /priority/i }) as HTMLSelectElement
const chipsOfRow = () => within(toggle().closest('[data-no-priority-row]') as HTMLElement)
  .queryAllByRole('link').filter((l) => !l.closest('[data-feed-bill-list]')).map((l) => l.textContent)
const asAdmin = () => authMock.mockReturnValue({ user: { id: 'u1', role: 'admin' } })

async function openRow(events: FeedEvent[], entries: unknown[], hasMore = false) {
  hoisted.pages.set(1, page(entries, hasMore))
  showFeed(events)
  await userEvent.click(toggle())
  await screen.findByRole('link', { name: `Act on ${(entries[0] as { bills: Bill[] }).bills[0].billNumber}` })
}
const choose = async (el: HTMLElement, value: string) => {
  fireEvent.change(selectIn(el), { target: { value } })
}
const feedFetches = () => hoisted.calls.filter((u) => u.startsWith('/feed?'))

beforeEach(() => {
  hoisted.poll = null
  hoisted.pages = new Map()
  hoisted.calls = []
  hoisted.patches = []
  hoisted.failing = new Set()
  hoisted.held = new Map()
  hoisted.respond = null
  refreshSidebar.mockReset()
  asAdmin()
})

describe('an admin\'s expanded row', () => {
  it('shows the priority dropdown on every entry: "Set priority", or amber "New · Set priority" for an untriaged new match', async () => {
    await openRow([row(3, [A, B])], [entry([A]), entry([B], { newMatch: true }), entry([C])])
    const selects = screen.getAllByRole('combobox', { name: /priority/i }) as HTMLSelectElement[]
    expect(selects).toHaveLength(3)

    const plain = selectIn(entryOf('Act on HB1'))
    expectClosedLabel(plain, 'Set priority')
    expectNotAmber(plain)
    const fresh = selectIn(entryOf('Act on HB2'))
    expectClosedLabel(fresh, 'New · Set priority')
    expectAmber(fresh)
    expect(Array.from(fresh.options).map((o) => o.textContent)).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority', 'Dismiss (reviewed, no priority)'])
    expect(Array.from(plain.options).map((o) => o.textContent)).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority'])
  })

  it('shows no dropdown in the collapsed row', () => {
    showFeed([row(3, [A, B])])
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })

  it('an owner gets the dropdowns too', async () => {
    authMock.mockReturnValue({ user: { id: 'u1', role: 'owner' } })
    await openRow([row(1, [A])], [entry([A])])
    expect(screen.getAllByRole('combobox', { name: /priority/i })).toHaveLength(1)
  })
})

describe('choosing a priority', () => {
  it('saves it against that bill, takes it out of the list, and lowers the count, chips, and "+N" in place without refetching the feed', async () => {
    await openRow([row(5, [A, B])], [entry([A]), entry([B]), entry([C]), entry([D]), entry([E])])
    expect(toggle()).toHaveAccessibleName('Updates on 5 bills with no priority')
    expect(chipsOfRow()).toEqual(['HB1', 'HB2'])
    expect(screen.getByText('+3')).toBeInTheDocument()

    await choose(entryOf('Act on HB1'), 'high')

    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())
    expect(hoisted.patches).toEqual([{ url: '/bills/ba/priority', body: { priority: 'high' } }])
    expect(toggle()).toHaveAccessibleName('Updates on 4 bills with no priority')
    expect(chipsOfRow()).toEqual(['HB2', 'HB3'])
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(box().querySelectorAll('[data-bill-entry]')).toHaveLength(4)
    expect(feedFetches()).toEqual([])
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('lowers the count and keeps the chips when the bill was not one of the two', async () => {
    await openRow([row(4, [A, B])], [entry([A]), entry([B]), entry([C]), entry([D])])
    await choose(entryOf('Act on HB4'), 'low')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB4' })).toBeNull())
    expect(toggle()).toHaveAccessibleName('Updates on 3 bills with no priority')
    expect(chipsOfRow()).toEqual(['HB1', 'HB2'])
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('reads "Updates on 1 bill with no priority" with one chip and no "+N" when one is left', async () => {
    await openRow([row(2, [A, B])], [entry([A]), entry([B])])
    await choose(entryOf('Act on HB2'), 'medium')
    await waitFor(() => expect(toggle()).toHaveAccessibleName('Updates on 1 bill with no priority'))
    expect(chipsOfRow()).toEqual(['HB1'])
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
    expect(screen.getAllByRole('combobox', { name: /priority/i })).toHaveLength(1)
  })

  it('hides the row, and its day, when the last bill leaves', async () => {
    await openRow([row(1, [A])], [entry([A])])
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(screen.queryByText(/with no priority/i)).toBeNull())
    expect(document.querySelector('[data-feed-day]')).toBeNull()
  })

  it('leaves the other rows and cards of the feed alone', async () => {
    const other = { ...row(2, [C, D]), id: 'row2', createdAt: '2026-03-03 06:00:00' } as FeedEvent
    await openRow([row(2, [A, B]), other], [entry([A]), entry([B])])
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Updates on 1 bill with no priority' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Updates on 2 bills with no priority' })).toBeInTheDocument()
  })

  it('refreshes the sidebar, as a card\'s dropdown does', async () => {
    await openRow([row(2, [A, B])], [entry([A]), entry([B])])
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(refreshSidebar).toHaveBeenCalledTimes(1))
  })

  it('gives the bill\'s other cards in the feed its new priority', async () => {
    const card = {
      ...base, billMatchType: 'keyword', id: 'c1', type: 'comment_added', billId: 'ba', billNumber: 'HB1', billTitle: 'Act on HB1',
      billSessionSlug: '2026', billState: 'RI', userId: 'u2', userName: 'Ada Admin', metadata: { preview: 'Worth a look.' }, createdAt: '2026-03-02 15:00:00',
    } as FeedEvent
    await openRow([row(2, [A, B]), card], [entry([A]), entry([B])])
    const cardSelect = () => screen.getAllByRole('combobox', { name: /priority/i }).find((s) => !s.closest('[data-feed-bill-list]')) as HTMLSelectElement
    expect(cardSelect().value).toBe('__none__')
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(cardSelect().value).toBe('high'))
  })

  it('shows the server\'s own count on the next read, not the in-place count twice', async () => {
    await openRow([row(5, [A, B])], [entry([A]), entry([B]), entry([C]), entry([D]), entry([E])])
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(toggle()).toHaveAccessibleName('Updates on 4 bills with no priority'))

    // The next read: the server resolves the row without the bill, and the bill's update is a card.
    const main = document.createElement('main')
    main.className = 'app-main'
    document.body.appendChild(main)
    const card = {
      ...base, billMatchType: 'keyword', billPriority: 'high', id: 'u9', type: 'bill_updated', billId: 'ba', billNumber: 'HB1', billTitle: 'Act on HB1',
      billSessionSlug: '2026', billState: 'RI', userId: 'system', userName: '', metadata: action('x', 'ba').metadata, createdAt: '2026-03-04 10:00:00',
    } as FeedEvent
    const comment = { ...card, id: 'c9', type: 'comment_added', metadata: { preview: 'Noted.' }, userId: 'u2', userName: 'Ada Admin', createdAt: '2026-03-05 09:00:00' } as FeedEvent
    hoisted.feed = { events: [comment, card, row(4, [B, C])], total: 3, page: 1, limit: 40 }
    await act(async () => { await hoisted.poll!() })
    await waitFor(() => expect(feedFetches().length).toBe(1))
    await waitFor(() => expect(screen.getAllByText('Act on HB1', { selector: 'div' }).length).toBeGreaterThan(0))
    expect(toggle()).toHaveAccessibleName('Updates on 4 bills with no priority')
    main.remove()
  })
})

describe('a companion group\'s entry', () => {
  const SB5 = bill('s5', 'SB5', { groupKey: 'g1' })
  const HB6 = bill('h6', 'HB6', { groupKey: 'g1' })

  it('sets the group\'s priority through its lead bill, and leaves the row as one entry', async () => {
    await openRow([row(3, [SB5, B])], [entry([SB5, HB6]), entry([B]), entry([C])])
    const group = entryOf('Act on SB5')
    expect(within(group).getAllByRole('combobox', { name: /priority/i })).toHaveLength(1)

    await choose(group, 'low')

    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on SB5' })).toBeNull())
    expect(hoisted.patches).toEqual([{ url: '/bills/s5/priority', body: { priority: 'low' } }])
    expect(screen.queryByRole('link', { name: 'HB6' })).toBeNull()
    expect(toggle()).toHaveAccessibleName('Updates on 2 bills with no priority')
    expect(chipsOfRow()).toEqual(['HB2', 'HB3'])
  })

  it('shows the amber state for a group that is a new match', async () => {
    await openRow([row(1, [SB5])], [entry([SB5, HB6], { newMatch: true })])
    expectAmber(selectIn(entryOf('Act on SB5')))
  })
})

describe('Dismiss on a new match', () => {
  it('triages the bill and leaves it in the row as a plain "Set priority" entry, count and chips unchanged', async () => {
    await openRow([row(2, [A, B])], [entry([A], { newMatch: true }), entry([B])])
    const fresh = () => selectIn(entryOf('Act on HB1'))
    expectAmber(fresh())

    await choose(entryOf('Act on HB1'), 'dismiss')

    await waitFor(() => expectNotAmber(fresh()))
    expectClosedLabel(fresh(), 'Set priority')
    expect(Array.from(fresh().options).map((o) => o.textContent)).not.toContain('Dismiss (reviewed, no priority)')
    expect(hoisted.patches).toEqual([{ url: '/bills/ba/triage-dismiss', body: undefined }])
    expect(screen.getByRole('link', { name: 'Act on HB1' })).toBeInTheDocument()
    expect(toggle()).toHaveAccessibleName('Updates on 2 bills with no priority')
    expect(chipsOfRow()).toEqual(['HB1', 'HB2'])
    expect(feedFetches()).toEqual([])
  })

  it('a failed Dismiss leaves the entry amber, with the dropdown\'s message', async () => {
    hoisted.failing.add('/bills/ba/triage-dismiss')
    await openRow([row(1, [A])], [entry([A], { newMatch: true })])
    await choose(entryOf('Act on HB1'), 'dismiss')
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't dismiss. Try again.")
    expectAmber(selectIn(entryOf('Act on HB1')))
  })

  it('then lets the entry take a priority, which removes it', async () => {
    await openRow([row(2, [A, B])], [entry([A], { newMatch: true }), entry([B])])
    await choose(entryOf('Act on HB1'), 'dismiss')
    await waitFor(() => expectNotAmber(selectIn(entryOf('Act on HB1'))))
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(toggle()).toHaveAccessibleName('Updates on 1 bill with no priority'))
  })
})

describe('each dropdown names its bill', () => {
  it('reads "Priority for <bill number>", and says so for a new match too', async () => {
    await openRow([row(2, [A, B])], [entry([A]), entry([B], { newMatch: true })])
    expect(screen.getByRole('combobox', { name: 'Priority for HB1' })).toBe(selectIn(entryOf('Act on HB1')))
    expect(screen.getByRole('combobox', { name: 'Priority for HB2 (new match: set a priority or dismiss)' })).toBe(selectIn(entryOf('Act on HB2')))
  })

  it('names a companion group\'s dropdown for its lead bill', async () => {
    const SB5 = bill('s5', 'SB5', { groupKey: 'g1' })
    const HB6 = bill('h6', 'HB6', { groupKey: 'g1' })
    await openRow([row(1, [SB5])], [entry([SB5, HB6])])
    expect(screen.getByRole('combobox', { name: 'Priority for SB5' })).toBeInTheDocument()
  })
})

describe('keyboard focus through Dismiss', () => {
  it('stays on the same dropdown after Dismiss turns it from amber to plain', async () => {
    await openRow([row(1, [A])], [entry([A], { newMatch: true })])
    const before = selectIn(entryOf('Act on HB1'))
    before.focus()
    expect(before).toHaveFocus()

    await choose(entryOf('Act on HB1'), 'dismiss')

    await waitFor(() => expectNotAmber(selectIn(entryOf('Act on HB1'))))
    expect(selectIn(entryOf('Act on HB1'))).toBe(before)
    expect(before).toHaveFocus()
  })
})

describe('a member\'s expanded row', () => {
  beforeEach(() => authMock.mockReturnValue({ user: { id: 'u1', role: 'member' } }))

  it('has no dropdown, only the read-only "New match" label on an untriaged new match, and nothing on the rest', async () => {
    await openRow([row(2, [A, B])], [entry([A], { newMatch: true }), entry([B])])
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(within(entryOf('Act on HB1')).getByText('New match')).toBeInTheDocument()
    expect(within(entryOf('Act on HB2')).queryByText('New match')).toBeNull()
    expect(screen.queryByText(/Set priority/)).toBeNull()
  })

  it('shows a viewer with no role the same read-only view', async () => {
    authMock.mockReturnValue({ user: { id: 'u1' } })
    await openRow([row(1, [A])], [entry([A], { newMatch: true })])
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.getByText('New match')).toBeInTheDocument()
  })
})

describe('a failed save', () => {
  it('leaves the bill in the row, with its count and chips, and shows the dropdown\'s error', async () => {
    hoisted.failing.add('/bills/ba/priority')
    await openRow([row(2, [A, B])], [entry([A]), entry([B])])
    await choose(entryOf('Act on HB1'), 'high')

    const alert = await within(entryOf('Act on HB1')).findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't save priority. Try again.")
    expect(screen.getByRole('link', { name: 'Act on HB1' })).toBeInTheDocument()
    expect(toggle()).toHaveAccessibleName('Updates on 2 bills with no priority')
    expect(chipsOfRow()).toEqual(['HB1', 'HB2'])
    expectClosedLabel(selectIn(entryOf('Act on HB1')), 'Set priority')
    expect(refreshSidebar).not.toHaveBeenCalled()
  })

  it('can be retried, and then leaves the row', async () => {
    hoisted.failing.add('/bills/ba/priority')
    await openRow([row(2, [A, B])], [entry([A]), entry([B])])
    await choose(entryOf('Act on HB1'), 'high')
    await within(entryOf('Act on HB1')).findByRole('alert')

    hoisted.failing.clear()
    await choose(entryOf('Act on HB1'), 'medium')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())
    expect(toggle()).toHaveAccessibleName('Updates on 1 bill with no priority')
  })
})

describe('using the dropdown', () => {
  it('does not follow a link or collapse the row, on click, mousedown, or auxclick', async () => {
    await openRow([row(2, [A, B])], [entry([A]), entry([B])])
    const select = selectIn(entryOf('Act on HB1'))
    expect(select.closest('a')).toBeNull()
    await userEvent.click(select)
    fireEvent.mouseDown(select)
    fireEvent.click(select)
    fireEvent(select, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(screen.getByTestId('where')).toHaveTextContent('/')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Act on HB1' })).toBeInTheDocument()
  })

  it('does not collapse the row or navigate when a priority is chosen, either', async () => {
    await openRow([row(2, [A, B])], [entry([A]), entry([B])])
    await choose(entryOf('Act on HB2'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB2' })).toBeNull())
    expect(screen.getByTestId('where')).toHaveTextContent('/')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('can be driven from the keyboard: the first stop after the empty choice is High, and choosing it saves', async () => {
    await openRow([row(2, [A, B])], [entry([A]), entry([B])])
    const select = selectIn(entryOf('Act on HB1'))
    select.focus()
    expect(select).toHaveFocus()
    // ArrowDown on a closed select selects the next option, so it has to be a real choice, as #931 left it.
    expect(select.options[select.selectedIndex].textContent).toBe('No priority')
    expect(select.options[select.selectedIndex + 1].textContent).toBe('High Priority')
    await userEvent.selectOptions(select, select.options[select.selectedIndex + 1].value)
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())
    expect(hoisted.patches).toEqual([{ url: '/bills/ba/priority', body: { priority: 'high' } }])
  })

  it('is reached with Tab from the entry\'s title link', async () => {
    await openRow([row(1, [A])], [entry([A])])
    const title = screen.getAllByRole('link', { name: 'Act on HB1' })[0]
    title.focus()
    await userEvent.tab()
    expect(selectIn(entryOf('Act on HB1'))).toHaveFocus()
  })

  it('keeps a failed save\'s message, wide as it is, inside the list\'s box at its right edge', async () => {
    hoisted.failing.add('/bills/ba/priority')
    await openRow([row(1, [A])], [entry([A])])
    await choose(entryOf('Act on HB1'), 'high')
    const alert = await screen.findByRole('alert')
    expect(alert.style.right).toBe('0px')
  })
})

describe('the rest of a long list, after bills have left it', () => {
  it('asks for the next page counting the bills dropped from the pages it has, so none is skipped', async () => {
    hoisted.pages.set(2, { entries: [entry([D])], total: 4, page: 2, limit: 50, hasMore: false })
    await openRow([row(4, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())

    Object.defineProperty(box(), 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(box(), 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(box(), 'scrollTop', { configurable: true, value: 700, writable: true })
    fireEvent.scroll(box())
    expect(await screen.findByRole('link', { name: 'Act on HB4' })).toBeInTheDocument()
    expect(hoisted.calls.filter((u) => u.includes('/bills?'))).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2&removed=1'])
  })

  it('asks for the plain next page when nothing has left', async () => {
    hoisted.pages.set(2, { entries: [entry([D])], total: 4, page: 2, limit: 50, hasMore: false })
    await openRow([row(4, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    Object.defineProperty(box(), 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(box(), 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(box(), 'scrollTop', { configurable: true, value: 700, writable: true })
    fireEvent.scroll(box())
    await screen.findByRole('link', { name: 'Act on HB4' })
    expect(hoisted.calls.filter((u) => u.includes('/bills?'))).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2'])
  })

  it('counts a dropped bill on a later page too', async () => {
    hoisted.pages.set(2, { entries: [entry([D]), entry([E])], total: 5, page: 2, limit: 50, hasMore: true })
    hoisted.pages.set(3, { entries: [], total: 5, page: 3, limit: 50, hasMore: false })
    await openRow([row(5, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    const scrollToEnd = () => {
      Object.defineProperty(box(), 'scrollHeight', { configurable: true, value: 1000 })
      Object.defineProperty(box(), 'clientHeight', { configurable: true, value: 300 })
      Object.defineProperty(box(), 'scrollTop', { configurable: true, value: 700, writable: true })
      fireEvent.scroll(box())
    }
    scrollToEnd()
    await screen.findByRole('link', { name: 'Act on HB5' })
    await choose(entryOf('Act on HB5'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB5' })).toBeNull())
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())
    scrollToEnd()
    await waitFor(() => expect(hoisted.calls.filter((u) => u.includes('/bills?'))[2]).toBe('/feed/events/row/bills?page=3&removed=2'))
  })
})

describe('a box with nothing left to scroll', () => {
  const sizeBox = (scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(box(), 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(box(), 'clientHeight', { configurable: true, value: clientHeight })
  }
  const listCalls = () => hoisted.calls.filter((u) => u.includes('/bills?'))

  it('loads the next page by itself once removals leave nothing to scroll, counting what was dropped', async () => {
    hoisted.pages.set(2, { entries: [entry([D])], total: 4, page: 2, limit: 50, hasMore: false })
    await openRow([row(4, [A, B])], [entry([A]), entry([B]), entry([C])], true)

    sizeBox(1000, 300) // still a scrollbar: the reader can scroll to the end from here
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1'])

    sizeBox(100, 300) // the box no longer overflows, so no scroll event can ever come
    await choose(entryOf('Act on HB2'), 'high')
    expect(await screen.findByRole('link', { name: 'Act on HB4' })).toBeInTheDocument()
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2&removed=2'])
  })

  it('keeps going while there is nothing to scroll, and stops once the last page has arrived', async () => {
    hoisted.pages.set(2, { entries: [entry([D])], total: 5, page: 2, limit: 50, hasMore: true })
    hoisted.pages.set(3, { entries: [entry([E])], total: 5, page: 3, limit: 50, hasMore: false })
    await openRow([row(5, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    sizeBox(100, 300)
    await choose(entryOf('Act on HB1'), 'high')
    expect(await screen.findByRole('link', { name: 'Act on HB5' })).toBeInTheDocument()
    await act(async () => {})
    expect(listCalls()).toEqual([
      '/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2&removed=1', '/feed/events/row/bills?page=3&removed=1',
    ])
  })

  it('loads nothing by itself before the box has been laid out, or when it overflows', async () => {
    hoisted.pages.set(2, { entries: [entry([D])], total: 4, page: 2, limit: 50, hasMore: false })
    await openRow([row(4, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    await act(async () => {})
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1'])
    sizeBox(900, 300)
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())
    await act(async () => {})
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1'])
  })
})

describe('a list drained of every loaded entry', () => {
  it('asks for the next page, counting the bills dropped, and lists what comes, with no box to measure and no scroll', async () => {
    hoisted.pages.set(2, { entries: [entry([C]), entry([D])], total: 3, page: 2, limit: 50, hasMore: false })
    await openRow([row(3, [A, B])], [entry([A])], true)

    await choose(entryOf('Act on HB1'), 'high')

    expect(await screen.findByRole('link', { name: 'Act on HB3' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Act on HB4' })).toBeInTheDocument()
    expect(hoisted.calls.filter((u) => u.includes('/bills?'))).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2&removed=1'])
    expect(screen.queryByText(/no longer available/)).toBeNull()
  })

  it('does not ask again once the last page has come back, even with nothing in the box', async () => {
    hoisted.pages.set(2, { entries: [], total: 0, page: 2, limit: 50, hasMore: false })
    await openRow([row(2, [A, B])], [entry([A])], true)
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(hoisted.calls.filter((u) => u.includes('/bills?'))).toHaveLength(2))
    await act(async () => {})
    expect(hoisted.calls.filter((u) => u.includes('/bills?'))).toHaveLength(2)
  })
})

describe('collapsing and re-expanding the row', () => {
  const sizeBox = (scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(box(), 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(box(), 'clientHeight', { configurable: true, value: clientHeight })
  }
  const listCalls = () => hoisted.calls.filter((u) => u.includes('/bills?'))

  it('keeps the entries that are left, and the row\'s count, without asking for page one again', async () => {
    await openRow([row(3, [A, B])], [entry([A]), entry([B]), entry([C])])
    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())

    await userEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle())

    expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Act on HB2' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Act on HB3' })).toBeInTheDocument()
    expect(toggle()).toHaveAccessibleName('Updates on 2 bills with no priority')
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1'])
  })

  it('loads nothing by itself for a page that lands while the row is collapsed, and picks up once it is open again', async () => {
    let release!: () => void
    hoisted.held.set(2, new Promise<void>((resolve) => { release = resolve }))
    hoisted.pages.set(2, { entries: [entry([D])], total: 5, page: 2, limit: 50, hasMore: true })
    hoisted.pages.set(3, { entries: [entry([E])], total: 5, page: 3, limit: 50, hasMore: false })
    await openRow([row(5, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    sizeBox(1000, 300)
    Object.defineProperty(box(), 'scrollTop', { configurable: true, value: 700, writable: true })
    fireEvent.scroll(box())
    await waitFor(() => expect(listCalls()).toHaveLength(2))

    await userEvent.click(toggle()) // collapsed: the box is hidden, so it has no height
    sizeBox(0, 0)
    release()
    await act(async () => {})
    await waitFor(() => expect(hoisted.calls.length).toBeGreaterThan(0))
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2'])

    // Open again: the box has height, the entries are few, and more are on the server.
    sizeBox(100, 300)
    await userEvent.click(toggle())
    expect(await screen.findByRole('link', { name: 'Act on HB5' })).toBeInTheDocument()
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2', '/feed/events/row/bills?page=3'])
  })

  it('still loads by itself after a removal once it has been re-expanded', async () => {
    hoisted.pages.set(2, { entries: [entry([D])], total: 4, page: 2, limit: 50, hasMore: false })
    await openRow([row(4, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    await userEvent.click(toggle())
    await userEvent.click(toggle())
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1'])
    sizeBox(100, 300)
    await choose(entryOf('Act on HB1'), 'high')
    expect(await screen.findByRole('link', { name: 'Act on HB4' })).toBeInTheDocument()
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2&removed=1'])
  })
})

describe('a bill that leaves while the next page is on its way', () => {
  const scrollToEnd = () => {
    Object.defineProperty(box(), 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(box(), 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(box(), 'scrollTop', { configurable: true, value: 700, writable: true })
    fireEvent.scroll(box())
  }
  const listCalls = () => hoisted.calls.filter((u) => u.includes('/bills?'))
  const STALE = bill('bs', 'HB9')

  it('discards that page, which started a bill too late, and asks again counting it', async () => {
    let release!: () => void
    hoisted.held.set(2, new Promise<void>((resolve) => { release = resolve }))
    // The server answers as it was asked: with nothing dropped, it starts late and leaves HB4 out.
    hoisted.respond = (page, removed) => (page === 2
      ? { entries: [entry(removed === 0 ? [STALE] : [D])], total: 4, page: 2, limit: 50, hasMore: false }
      : undefined)
    await openRow([row(4, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    scrollToEnd()
    await waitFor(() => expect(listCalls()).toHaveLength(2))

    await choose(entryOf('Act on HB1'), 'high')
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Act on HB1' })).toBeNull())
    release()

    expect(await screen.findByRole('link', { name: 'Act on HB4' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Act on HB9' })).toBeNull()
    expect(listCalls()).toEqual(['/feed/events/row/bills?page=1', '/feed/events/row/bills?page=2', '/feed/events/row/bills?page=2&removed=1'])
  })

  it('keeps a page that nothing left during, asking once', async () => {
    let release!: () => void
    hoisted.held.set(2, new Promise<void>((resolve) => { release = resolve }))
    hoisted.pages.set(2, { entries: [entry([D])], total: 4, page: 2, limit: 50, hasMore: false })
    await openRow([row(4, [A, B])], [entry([A]), entry([B]), entry([C])], true)
    scrollToEnd()
    await waitFor(() => expect(listCalls()).toHaveLength(2))
    release()
    expect(await screen.findByRole('link', { name: 'Act on HB4' })).toBeInTheDocument()
    expect(listCalls()).toHaveLength(2)
  })
})

const box = () => document.querySelector('[data-feed-bill-list]') as HTMLElement
