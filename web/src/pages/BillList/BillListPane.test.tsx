import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { color } from '../../styles/tokens'
import { decodeStatus } from '../../lib/legislativeStatus'
import type { Bill, GroupMember } from './types'

// The pane is exercised on its own here (the App-level file covers its mount
// in AppLayout): a MemoryRouter at the open bill's URL, a scripted /bills
// response, and the Bills page's module-level caches stubbed so a test can say
// what the list page had warmed.

const hoisted = vi.hoisted(() => ({
  calls: [] as string[],
  respond: null as null | ((path: string) => unknown),
  cache: null as null | { params: string; page: { bills: unknown[]; total: number; totalPages: number } },
  defs: [] as { id: string; slug: string | null }[],
}))

vi.mock('../../lib/api', () => ({
  apiFetch: async (path: string) => {
    hoisted.calls.push(path)
    const out = hoisted.respond ? hoisted.respond(path) : {}
    if (out instanceof Error) throw out
    return out
  },
  ApiError: class ApiError extends Error {},
}))
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))
vi.mock('./index', () => ({
  peekBillsListCache: () => hoisted.cache,
  peekCustomFieldDefs: () => hoisted.defs,
}))

import { BillListPane } from './BillListPane'

const member = (id: string, billNumber: string, status: string, over: Partial<GroupMember> = {}): GroupMember =>
  ({ id, billNumber, state: 'RI', status, sessionSlug: '2026', ...over })

function bill(id: string, billNumber: string, over: Partial<Bill> = {}): Bill {
  return {
    id, billNumber, title: `Title of ${billNumber}`, state: 'RI', status: 'Introduced',
    session: '2026', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null, lastActionDate: null, tenantSummary: null,
    tags: [], priority: null, matchType: null, isDraft: false, position: null, relevanceScore: null,
    aiProcessedAt: null, newMatchAt: null, triagedAt: null,
    voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-01-01 00:00:00',
    customFieldValues: {}, ...over,
  }
}

// A group of three: S 5 leads (furthest along), H 5 is the one other shown, and
// H 6 hides behind "+1". Distinct statuses so each one shows.
const GROUP3 = bill('g1', 'S 5', {
  status: 'Passed',
  group: [member('g1', 'S 5', 'Passed'), member('g2', 'H 5', 'Introduced'), member('g3', 'H 6', 'Referred')],
})
// A group of two with the same status collapses to one status chip, no "+N".
const GROUP2 = bill('p1', 'S 9', {
  status: 'Introduced',
  group: [member('p1', 'S 9', 'Introduced'), member('p2', 'H 9', 'Introduced')],
})
const PLAIN = bill('b1', 'HB 1')

function page(bills: Bill[], extra: { total?: number; totalPages?: number; page?: number } = {}) {
  return { bills, pagination: { page: extra.page ?? 1, pageSize: 100, total: extra.total ?? bills.length, totalPages: extra.totalPages ?? 1 } }
}

const scrollSpy = vi.fn()
const realScroll = Element.prototype.scrollIntoView

function renderPane(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><BillListPane /></MemoryRouter>)
}
const rowFor = (pane: HTMLElement, text: RegExp) => within(pane).getByRole('link', { name: text })

beforeEach(() => {
  hoisted.calls = []
  hoisted.cache = null
  hoisted.defs = []
  hoisted.respond = (path) => path.startsWith('/bills?') ? page([PLAIN, GROUP3, GROUP2]) : {}
  sessionStorage.clear()
  scrollSpy.mockReset()
  Element.prototype.scrollIntoView = scrollSpy
})
afterEach(() => { Element.prototype.scrollIntoView = realScroll })

describe('BillListPane: group rows', () => {
  it('highlights the group row when the open bill is its lead', async () => {
    renderPane('/RI/2026/S%205')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    expect(within(pane).getByRole('link', { current: 'page' })).toHaveTextContent('Title of S 5')
  })

  it('highlights the group row when the open bill is a non-lead member shown on the row', async () => {
    renderPane('/RI/2026/H%205')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    const current = within(pane).getByRole('link', { current: 'page' })
    expect(current).toHaveTextContent('Title of S 5')
    // The row still links to its lead bill.
    expect(current).toHaveAttribute('href', '/RI/2026/S 5')
  })

  it('highlights the group row when the open bill is a member hidden behind "+N"', async () => {
    renderPane('/RI/2026/H%206')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    expect(within(pane).getByRole('link', { current: 'page' })).toHaveTextContent('Title of S 5')
  })

  it('highlights nothing for a bill in no row, and only one row otherwise', async () => {
    renderPane('/RI/2026/H%205')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    expect(within(pane).getAllByRole('link', { current: 'page' })).toHaveLength(1)
  })

  it('scrolls to the row when the open bill is a non-lead member', async () => {
    renderPane('/RI/2026/H%206')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled())
    const target = scrollSpy.mock.instances[0] as HTMLElement
    expect(target).toBe(within(pane).getByRole('link', { current: 'page' }))
  })

  it('scrolls with block "nearest" so an on-screen row does not move', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of HB 1')
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' }))
  })

  it('shows the lead and one other number with "+N" for the rest, as the Bills list does', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    const row = rowFor(pane, /Title of S 5/)
    expect(row).toHaveTextContent('S 5')
    expect(row).toHaveTextContent('H 5')
    expect(row).toHaveTextContent('+1')
    // The hidden member's own number is not drawn in the row.
    expect(within(row).queryByText('H 6')).toBeNull()
  })

  it('stacks each shown bill’s status, and collapses identical ones to one chip', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 9')
    const three = rowFor(pane, /Title of S 5/)
    expect(three).toHaveTextContent('Passed')
    expect(three).toHaveTextContent('Introduced')
    const two = rowFor(pane, /Title of S 9/)
    expect(two).not.toHaveTextContent('+')
    expect(within(two).getAllByText('Introduced')).toHaveLength(1)
  })

  it('names the companions in the row’s accessible name', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    expect(within(pane).getByRole('link', { name: /Title of S 5.*with 2 companion bills: H 5, H 6/ })).toBeInTheDocument()
    expect(within(pane).getByRole('link', { name: /Title of S 9.*with 1 companion bill: H 9/ })).toBeInTheDocument()
    // A bill with no companions says nothing of the kind.
    expect(rowFor(pane, /Title of HB 1/)).not.toHaveAccessibleName(/companion/)
  })

  it('passes the same one-path-per-row list to BillDetail, whatever a row holds', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    expect(within(pane).getAllByRole('listitem')).toHaveLength(3)
    expect(rowFor(pane, /Title of S 9/)).toHaveAttribute('href', '/RI/2026/S 9')
  })
})

describe('BillListPane: request params', () => {
  it('turns a custom-field slug in the URL into the field id, as the Bills page does', async () => {
    hoisted.defs = [{ id: 'cf-uuid-1', slug: 'tracked_by_team' }]
    sessionStorage.setItem('lastBillsUrl', '/bills?cf_tracked_by_team=yes&sort=bill&dir=asc')
    renderPane('/RI/2026/HB%201')
    await waitFor(() => expect(hoisted.calls.some(c => c.startsWith('/bills?'))).toBe(true))
    const q = new URLSearchParams(hoisted.calls.find(c => c.startsWith('/bills?'))!.slice('/bills?'.length))
    expect(q.getAll('cf_cf-uuid-1')).toEqual(['yes'])
    expect(q.has('cf_tracked_by_team')).toBe(false)
  })

  it('paints from the Bills page’s warmed cache for a custom-field list, then refreshes', async () => {
    hoisted.defs = [{ id: 'cf-uuid-1', slug: 'tracked_by_team' }]
    sessionStorage.setItem('lastBillsUrl', '/bills?cf_tracked_by_team=yes')
    const cachedParams = new URLSearchParams([['page', '1'], ['pageSize', '100'], ['cf_cf-uuid-1', 'yes']])
    hoisted.cache = { params: cachedParams.toString(), page: { bills: [bill('c1', 'HB 77')], total: 1, totalPages: 1 } }
    // The refresh never settles, so what shows is the cache's.
    hoisted.respond = () => new Promise(() => {})
    renderPane('/RI/2026/HB%2077')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    expect(await within(pane).findByText('Title of HB 77')).toBeInTheDocument()
    expect(screen.queryByText('Loading bills…')).toBeNull()
  })

  it('falls back to the unfiltered list when the saved view slug is unknown', async () => {
    sessionStorage.setItem('lastBillsUrl', '/bills?view=gone')
    hoisted.respond = (path) => path === '/views' ? { views: [] } : path.startsWith('/bills?') ? page([PLAIN]) : {}
    renderPane('/RI/2026/HB%201')
    await waitFor(() => expect(hoisted.calls.some(c => c.startsWith('/bills?'))).toBe(true))
    const q = new URLSearchParams(hoisted.calls.find(c => c.startsWith('/bills?'))!.slice('/bills?'.length))
    expect([...q.keys()].sort()).toEqual(['page', 'pageSize'])
  })

  it('shows the default list, and links back to /bills, when the Bills page was never visited', async () => {
    renderPane('/RI/2026/HB%201')
    await screen.findByText('Title of HB 1')
    expect(screen.getByRole('link', { name: 'Bills' })).toHaveAttribute('href', '/bills')
    const q = new URLSearchParams(hoisted.calls.find(c => c.startsWith('/bills?'))!.slice('/bills?'.length))
    expect([...q.keys()].sort()).toEqual(['page', 'pageSize'])
  })
})

describe('BillListPane: load more', () => {
  const firstPage = Array.from({ length: 3 }, (_, i) => bill(`a${i}`, `HB ${i + 1}`))
  const secondPage = [bill('a3', 'HB 4'), bill('a4', 'HB 5')]

  beforeEach(() => {
    hoisted.respond = (path) => {
      if (!path.startsWith('/bills?')) return {}
      return new URLSearchParams(path.slice(7)).get('page') === '2'
        ? page(secondPage, { page: 2, total: 5, totalPages: 2 })
        : page(firstPage, { total: 5, totalPages: 2 })
    }
  })

  it('offers "Show more" with the count, appends the next page, and then hides the button', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    const more = await within(pane).findByRole('button', { name: 'Show more (3 of 5)' })
    expect(within(pane).getByText('5 bills')).toBeInTheDocument()

    fireEvent.click(more)
    await within(pane).findByText('Title of HB 5')
    expect(within(pane).getAllByRole('listitem')).toHaveLength(5)
    expect(within(pane).queryByRole('button', { name: /Show more/ })).toBeNull()
    const billCalls = hoisted.calls.filter(c => c.startsWith('/bills?'))
    const q = new URLSearchParams(billCalls[billCalls.length - 1].slice(7))
    expect(q.get('page')).toBe('2')
  })

  it('does not scroll the reader back to the current bill when more rows arrive', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    const more = await within(pane).findByRole('button', { name: /Show more/ })
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1))
    fireEvent.click(more)
    await within(pane).findByText('Title of HB 5')
    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores a second click while the page is loading', async () => {
    let release: (v: unknown) => void = () => {}
    hoisted.respond = (path) => {
      if (!path.startsWith('/bills?')) return {}
      if (new URLSearchParams(path.slice(7)).get('page') === '2') return new Promise(r => { release = r })
      return page(firstPage, { total: 5, totalPages: 2 })
    }
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    fireEvent.click(await within(pane).findByRole('button', { name: /Show more/ }))
    const busy = await within(pane).findByRole('button', { name: 'Loading…' })
    expect(busy).toBeDisabled()
    fireEvent.click(busy)
    expect(hoisted.calls.filter(c => c.startsWith('/bills?') && c.includes('page=2'))).toHaveLength(1)
    await act(async () => { release(page(secondPage, { page: 2, total: 5, totalPages: 2 })) })
    await within(pane).findByText('Title of HB 5')
  })
})

describe('BillListPane: loading, error and empty states', () => {
  it('says it is loading until the list arrives', async () => {
    let release: (v: unknown) => void = () => {}
    hoisted.respond = (path) => path.startsWith('/bills?') ? new Promise(r => { release = r }) : {}
    renderPane('/RI/2026/HB%201')
    expect(await screen.findByText('Loading bills…')).toBeInTheDocument()
    expect(screen.queryByText(/bills$/)).toBeNull()
    // The request goes out a tick after the first paint; release only once it has.
    await waitFor(() => expect(hoisted.calls.some(c => c.startsWith('/bills?'))).toBe(true))
    await act(async () => { release(page([PLAIN])) })
    expect(await screen.findByText('Title of HB 1')).toBeInTheDocument()
    expect(screen.getByText('1 bill')).toBeInTheDocument()
  })

  it('says so, with no count, when the list cannot be loaded', async () => {
    hoisted.respond = (path) => path.startsWith('/bills?') ? new Error('boom') : {}
    renderPane('/RI/2026/HB%201')
    expect(await screen.findByText('Couldn’t load bills.')).toBeInTheDocument()
    expect(screen.queryByText(/\d bills?$/)).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('says no bills match when the filters leave none', async () => {
    hoisted.respond = (path) => path.startsWith('/bills?') ? page([], { total: 0 }) : {}
    renderPane('/RI/2026/HB%201')
    expect(await screen.findByText('No bills match this list’s filters.')).toBeInTheDocument()
    expect(screen.getByText('0 bills')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })
})


// The filters and sort the pane carries, said under the "Bills" header.
describe('BillListPane: filter and sort summary', () => {
  const VIEW = { id: 'v-1', name: 'Watch list', slug: 'watch-list', previousSlug: 'old-watch', query: 'status=2&status=3&sort=bill&dir=asc' }
  function listAt(url: string, extra: Record<string, unknown> = {}) {
    sessionStorage.setItem('lastBillsUrl', url)
    hoisted.respond = (path) => {
      if (path === '/views') return { views: [VIEW] }
      if (path.startsWith('/bills?')) return page([PLAIN, GROUP3], { total: 2, ...extra })
      return {}
    }
  }
  async function paneReady(path = '/RI/2026/HB%201') {
    renderPane(path)
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of HB 1')
    return pane
  }
  const hover = (el: HTMLElement) => fireEvent.pointerEnter(el, { pointerType: 'mouse' })

  it('says "All bills" with the default sort named when the list has no filters', async () => {
    const pane = await paneReady()
    expect(within(pane).getByText('All bills · Sorted by default order')).toBeInTheDocument()
  })

  it('counts each selected value, and names the sort as its column header does', async () => {
    listAt('/bills?status=2&status=3&priority=high&sort=lastAction&dir=desc')
    const pane = await paneReady()
    expect(within(pane).getByText('3 filters · Sorted by Last action')).toBeInTheDocument()
  })

  it('says "1 filter" for one value', async () => {
    listAt('/bills?year=2026')
    const pane = await paneReady()
    expect(within(pane).getByText('1 filter · Sorted by default order')).toBeInTheDocument()
  })

  it('counts the New matches pill the sidebar links to, rather than saying "All bills"', async () => {
    listAt('/bills?newMatches=1')
    const pane = await paneReady()
    expect(within(pane).getByText('1 filter · Sorted by default order')).toBeInTheDocument()
    expect(within(pane).queryByText(/All bills/)).toBeNull()
    hover(within(pane).getByRole('button', { name: /1 filter/ }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('New matches')
  })

  it('counts the Not yet voted pill together with the priority tiers the unvoted widget links with', async () => {
    listAt('/bills?priority=high&priority=medium&priority=low&unvoted=1')
    const pane = await paneReady()
    expect(within(pane).getByText('4 filters · Sorted by default order')).toBeInTheDocument()
    expect(within(pane).getByRole('button', { name: /4 filters/ })).toHaveAccessibleDescription(/Not yet voted/)
  })

  it('counts a search term as one filter', async () => {
    listAt('/bills?q=water')
    const pane = await paneReady()
    expect(within(pane).getByText('1 filter · Sorted by default order')).toBeInTheDocument()
    // The same search narrows the pane's own list, so the line is not a lie.
    expect(hoisted.calls.find(c => c.startsWith('/bills?'))).toContain('q=water')
  })

  it('draws the line under the header, between the title row and the list', async () => {
    listAt('/bills?status=2')
    const pane = await paneReady()
    const summary = within(pane).getByText(/^1 filter · Sorted by/)
    const heading = within(pane).getByRole('link', { name: 'Bills' })
    const list = within(pane).getAllByRole('list')[0]
    expect(heading.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(summary.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(pane).getByText('2 bills')).toBeInTheDocument()
  })

  it('shows the active filters on hover, labelled as the Bills page’s chips are', async () => {
    hoisted.defs = [{ id: 'f1', slug: 'team', name: 'Team', type: 'dropdown' } as never]
    listAt('/bills?priority=high&year=2026&minRelevance=5&cf_team=Alpha')
    const pane = await paneReady()
    expect(screen.queryByRole('tooltip')).toBeNull()
    hover(within(pane).getByRole('button', { name: /4 filters · Sorted by/ }))
    const tip = await screen.findByRole('tooltip')
    for (const label of ['Year: 2026', 'Relevance 5+', 'Team: Alpha']) expect(tip).toHaveTextContent(label)
    expect(tip).toHaveTextContent(/high/i)
  })

  it('shows the same list on keyboard focus, and Escape closes it', async () => {
    listAt('/bills?year=2026&year=2027')
    const pane = await paneReady()
    const trigger = within(pane).getByRole('button', { name: /2 filters/ })
    act(() => trigger.focus())
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Year: 2026')
    expect(tip).toHaveTextContent('Year: 2027')
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('makes the filter list a screen reader reads without opening anything', async () => {
    listAt('/bills?year=2026&year=2027&minRelevance=5')
    const pane = await paneReady()
    const trigger = within(pane).getByRole('button', { name: /3 filters/ })
    expect(trigger).toHaveAccessibleDescription(/Year: 2026.*Year: 2027.*Relevance 5\+/)
    expect(trigger.tabIndex).toBeGreaterThanOrEqual(0)
  })

  it('lists a search term in the hover list as a quoted search', async () => {
    listAt('/bills?q=water&year=2026')
    const pane = await paneReady()
    hover(within(pane).getByRole('button', { name: /2 filters/ }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Search: “water”')
  })

  it('has nothing to hover when there are no filters', async () => {
    const pane = await paneReady()
    expect(within(pane).getByText('All bills · Sorted by default order')).toBeInTheDocument()
    expect(within(pane).queryByRole('button', { name: /All bills/ })).toBeNull()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('caps a very long hover list and says how many more there are', async () => {
    listAt(`/bills?${Array.from({ length: 30 }, (_, i) => `status=s${i}`).join('&')}`)
    const pane = await paneReady()
    expect(within(pane).getByText('30 filters · Sorted by default order')).toBeInTheDocument()
    hover(within(pane).getByRole('button', { name: /30 filters/ }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('s0')
    expect(tip).toHaveTextContent('and 15 more')
    expect(tip).not.toHaveTextContent('s29')
  })

  it('links Edit filters to the same Bills URL as the "Bills" heading', async () => {
    listAt('/bills?status=2&sort=bill&dir=asc')
    const pane = await paneReady()
    const edit = within(pane).getByRole('link', { name: 'Edit filters' })
    expect(edit).toHaveAttribute('href', '/bills?status=2&sort=bill&dir=asc')
    expect(edit).toHaveAttribute('href', within(pane).getByRole('link', { name: 'Bills' }).getAttribute('href')!)
  })

  it('links Edit filters to /bills when the Bills page was never visited', async () => {
    const pane = await paneReady()
    expect(within(pane).getByRole('link', { name: 'Edit filters' })).toHaveAttribute('href', '/bills')
  })

  it('has no control that changes or removes a filter', async () => {
    listAt('/bills?status=2&status=3&q=water')
    const pane = await paneReady()
    const header = within(pane).getByRole('link', { name: 'Bills' }).parentElement!.parentElement!
    // The one button is the summary's own hover trigger; the only links are "Bills" and "Edit filters".
    expect(within(header).getAllByRole('button')).toHaveLength(1)
    expect(within(header).getAllByRole('link').map(l => l.textContent)).toEqual(['Bills', 'Edit filters'])
    expect(within(header).queryByText('×')).toBeNull()
    expect(within(header).queryByRole('button', { name: /clear|remove|reset/i })).toBeNull()
    // Nothing in the pane changes the list's URL or filters on click.
    fireEvent.click(within(pane).getByRole('button', { name: /3 filters/ }))
    expect(hoisted.calls.filter(c => c.startsWith('/bills?'))).toHaveLength(1)
  })

  describe('a saved view', () => {
    it('shows the view’s name in place of the count', async () => {
      listAt('/bills?view=watch-list')
      const pane = await paneReady()
      expect(within(pane).getByText('Watch list · Sorted by Bill')).toBeInTheDocument()
      expect(within(pane).queryByText(/ filters · /)).toBeNull()
    })

    it('finds the view by its id or its previous slug, as the pane’s list does', async () => {
      listAt('/bills?view=old-watch')
      const pane = await paneReady()
      expect(within(pane).getByText('Watch list · Sorted by Bill')).toBeInTheDocument()
    })

    it('still lists the view’s filters on hover', async () => {
      listAt('/bills?view=watch-list')
      const pane = await paneReady()
      hover(within(pane).getByRole('button', { name: /Watch list · Sorted by Bill/ }))
      const tip = await screen.findByRole('tooltip')
      expect(Array.from(tip.querySelectorAll('[data-filter]')).map(n => n.textContent)).toEqual([decodeStatus('2'), decodeStatus('3')])
    })

    it('says the view’s sort, not the URL’s', async () => {
      listAt('/bills?view=watch-list')
      const pane = await paneReady()
      expect(within(pane).getByText(/Sorted by Bill$/)).toBeInTheDocument()
    })

    it('still links Edit filters to the short view URL', async () => {
      listAt('/bills?view=watch-list')
      const pane = await paneReady()
      expect(within(pane).getByRole('link', { name: 'Edit filters' })).toHaveAttribute('href', '/bills?view=watch-list')
    })

    it('falls back to the filter count when the slug is stale', async () => {
      listAt('/bills?view=gone')
      const pane = await paneReady()
      expect(within(pane).getByText('All bills · Sorted by default order')).toBeInTheDocument()
      expect(within(pane).queryByText(/Watch list/)).toBeNull()
    })

    it('falls back to the count when /views cannot be loaded', async () => {
      sessionStorage.setItem('lastBillsUrl', '/bills?view=watch-list')
      hoisted.respond = (path) => path === '/views' ? new Error('down') : path.startsWith('/bills?') ? page([PLAIN]) : {}
      renderPane('/RI/2026/HB%201')
      expect(await screen.findByText('All bills · Sorted by default order')).toBeInTheDocument()
    })

    it('shows the count, not the view, once the URL spells out filters of its own', async () => {
      listAt('/bills?view=watch-list&status=9')
      const pane = await paneReady()
      expect(within(pane).getByText('1 filter · Sorted by default order')).toBeInTheDocument()
      expect(hoisted.calls).not.toContain('/views')
    })

    it('uses a long view name without pushing Edit filters out of the pane', async () => {
      const name = 'A very long saved view name that goes on and on and on and on'.repeat(3)
      sessionStorage.setItem('lastBillsUrl', '/bills?view=watch-list')
      hoisted.respond = (path) => path === '/views' ? { views: [{ ...VIEW, name }] } : path.startsWith('/bills?') ? page([PLAIN]) : {}
      renderPane('/RI/2026/HB%201')
      const pane = await screen.findByRole('navigation', { name: 'Bill list' })
      const line = await within(pane).findByText(`${name} · Sorted by Bill`)
      const row = line.closest('[data-pane-summary]') as HTMLElement
      // The row can shrink to the pane, the name wraps rather than overflowing, and Edit keeps its size.
      expect(row.getAttribute('style')).toMatch(/min-width: 0/)
      expect(row.style.display).toBe('flex')
      expect(row.getAttribute('style')).not.toMatch(/white-space: nowrap/)
      expect(line.closest('button')!.parentElement!.getAttribute('style')).toMatch(/min-width: 0/)
      expect(line.style.overflowWrap).toBe('anywhere')
      const edit = within(pane).getByRole('link', { name: 'Edit filters' })
      expect(edit.style.flexShrink).toBe('0')
      expect(edit.style.whiteSpace).toBe('nowrap')
    })
  })

  describe('when it is drawn', () => {
    it('is not drawn while the list is loading', async () => {
      hoisted.respond = (path) => path.startsWith('/bills?') ? new Promise(() => {}) : {}
      renderPane('/RI/2026/HB%201')
      await screen.findByText('Loading bills…')
      expect(screen.queryByText(/Sorted by/)).toBeNull()
      expect(screen.queryByRole('link', { name: 'Edit filters' })).toBeNull()
    })

    it('is not drawn after an error', async () => {
      hoisted.respond = (path) => path.startsWith('/bills?') ? new Error('boom') : {}
      renderPane('/RI/2026/HB%201')
      await screen.findByText('Couldn’t load bills.')
      expect(screen.queryByText(/Sorted by/)).toBeNull()
      expect(screen.queryByRole('link', { name: 'Edit filters' })).toBeNull()
    })

    it('is drawn when the filters leave no bills, so the reader can see why', async () => {
      listAt('/bills?status=2')
      hoisted.respond = (path) => path.startsWith('/bills?') ? page([], { total: 0 }) : {}
      renderPane('/RI/2026/HB%201')
      expect(await screen.findByText('1 filter · Sorted by default order')).toBeInTheDocument()
      expect(screen.getByText('No bills match this list’s filters.')).toBeInTheDocument()
    })

    it('is drawn from the Bills page’s warmed cache, before the refresh returns', async () => {
      listAt('/bills?status=2')
      hoisted.cache = { params: 'page=1&pageSize=100&status=2', page: { bills: [bill('c1', 'HB 77')], total: 1, totalPages: 1 } }
      hoisted.respond = () => new Promise(() => {})
      renderPane('/RI/2026/HB%2077')
      expect(await screen.findByText('1 filter · Sorted by default order')).toBeInTheDocument()
    })

    it('keeps the header’s title and count as they were', async () => {
      listAt('/bills?status=2')
      const pane = await paneReady()
      expect(within(pane).getByRole('link', { name: 'Bills' })).toHaveAttribute('href', '/bills?status=2')
      expect(within(pane).getByText('2 bills')).toBeInTheDocument()
    })
  })

  it('reads the list it is mounted with, so a changed filter shows on the next mount', async () => {
    listAt('/bills?status=2')
    const first = renderPane('/RI/2026/HB%201')
    await screen.findByText('1 filter · Sorted by default order')
    first.unmount()
    listAt('/bills?status=2&status=3&priority=high&sort=status')
    renderPane('/RI/2026/HB%201')
    expect(await screen.findByText('3 filters · Sorted by Status')).toBeInTheDocument()
    expect(screen.queryByText('1 filter · Sorted by default order')).toBeNull()
  })
})

describe('BillListPane: the open bill’s row', () => {
  it('has the blue highlight and no left border', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    const current = within(pane).getByRole('link', { current: 'page' })
    expect(current.style.background).toBe(color.bgBlueChip)
    expect(current.style.borderLeftStyle).toBe('')
    expect(current.style.borderLeftWidth).toBe('')
    expect(current.style.borderLeft).toBe('')
  })

  it('draws no left border on any row, so the blue is the only mark', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    for (const row of within(pane).getAllByRole('link', { name: /Title of/ })) {
      expect(row.style.borderLeft).toBe('')
      expect(row.style.borderLeftWidth).toBe('')
    }
  })

  it('keeps its text where the other rows’ text is', async () => {
    renderPane('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of S 5')
    const current = within(pane).getByRole('link', { current: 'page' })
    const other = within(pane).getByRole('link', { name: /Title of S 5/ })
    expect(current).not.toBe(other)
    // The 3px border's room was 12px + 3px of left space on every row; padding now holds all 15.
    expect(current.style.paddingLeft).toBe('15px')
    expect(other.style.paddingLeft).toBe('15px')
    expect(current.style.paddingRight).toBe(other.style.paddingRight)
  })

  it('keeps the same text position when the open bill is a different row', async () => {
    renderPane('/RI/2026/S%209')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Title of HB 1')
    const lefts = within(pane).getAllByRole('link', { name: /Title of/ }).map(r => r.style.paddingLeft)
    expect(new Set(lefts)).toEqual(new Set(['15px']))
  })
})
