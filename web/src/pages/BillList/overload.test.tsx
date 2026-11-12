// When D1 is overloaded (error 7429) the API answers GET /bills and GET /bills/facets with a 503 and Retry-After: 10.
// The list says it could not load and retries once after the interval, then shows the list; the filter menus show their
// failed state and ask again the next time they are opened. These run the real router, the real loader, and the real
// apiFetch over a stubbed fetch, so the 503 reaches the page the way it does in the browser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { facetsReply, isLazyFacetsCall } from '../../test/facetsContract'

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }),
}))

const BILL = {
  id: 'b1', billNumber: 'HB 1', title: 'Default bill', state: 'RI', status: '2',
  session: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026,
  abstract: null, url: null, stateUrl: null, lastAction: 'Referred',
  lastActionDate: '2026-02-01', tenantSummary: null, tags: [], priority: null,
  matchType: 'keyword', position: null, relevanceScore: 80, aiProcessedAt: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
  commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-02-01 10:00:00',
  customFieldValues: {},
}

const FACETS = {
  status: { '2': 1 }, priority: { high: 1 }, sessionName: {}, year: { '2025': 1 }, state: { RI: 1 }, position: {},
  tag: {}, field: {}, myBillsCount: 0, newMatchesCount: 0, unvotedCount: 0, draftCount: 0, hasDrafts: false,
  subject: { 'RI:Roads': 4 }, subjectStates: ['RI'], billStates: ['RI'],
  committee: {}, committeeInfo: {}, hasCommittees: false,
}

const net = vi.hoisted(() => ({
  /** Requests made, as `/api` paths. */
  calls: [] as string[],
  /** While true, GET /bills answers a 503 overload. */
  listOverloaded: false,
  /** While true, the on-demand facets request answers a 503 overload. */
  menuOverloaded: false,
}))

const overloaded = () => new Response(JSON.stringify({ error: 'database_overloaded' }), {
  status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '10' },
})
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input).replace(/^\/api/, '')
  net.calls.push(path)
  if (path === '/auth/me') {
    return json({ id: 'u1', email: 'u1@example.com', name: 'U1', role: 'member', title: null, canVote: true, emailDigestEnabled: false, lastSeenFeed: null })
  }
  if (path === '/config') return json({ associationName: 'Test Assoc', states: ['RI'], positionVocabulary: ['Support', 'Oppose'], orgNoun: 'association' })
  if (path === '/users/me/bills' || path === '/config/custom-fields') return json([])
  if (path.startsWith('/bills/facets')) {
    if (net.menuOverloaded && isLazyFacetsCall(path)) return overloaded()
    return json(facetsReply(path, FACETS))
  }
  if (path.startsWith('/bills?')) {
    if (net.listOverloaded) return overloaded()
    return json({ bills: [BILL], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } })
  }
  return json({})
}

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 150,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 150, size: 150 })),
    measureElement: () => {},
  }),
}))

import { BillList, billListLoader } from './index'
import { AuthProvider } from '../../context/AuthContext'
import { SidebarRefreshProvider } from '../../context/SidebarRefreshContext'

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  net.calls = []
  net.listOverloaded = false
  net.menuOverloaded = false
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The page under the data router, with its loader, at `url`. */
function renderPage(url = '/bills') {
  const router = createMemoryRouter(
    [{
      path: '/bills',
      loader: billListLoader,
      element: <AuthProvider><SidebarRefreshProvider><BillList /></SidebarRefreshProvider></AuthProvider>,
    }],
    { initialEntries: [url] },
  )
  render(<RouterProvider router={router} />)
}

const listCalls = () => net.calls.filter(p => p.startsWith('/bills?'))
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('the list when the database is overloaded', () => {
  // The loader's own prefetch and the page's fetch both meet the 503; neither may paint internal_error, and the page
  // retries once after the interval the API named.
  it('says the list could not load, retries once after the interval, then shows the list, never internal_error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    net.listOverloaded = true
    renderPage()
    expect(await screen.findByText('The list could not load. Retrying…')).toBeInTheDocument()
    expect(screen.queryByText(/internal_error|database_overloaded|Failed to load bills/)).toBeNull()
    expect(screen.queryByText('Default bill')).toBeNull()

    // The database recovers; nothing is asked until the interval has passed.
    net.listOverloaded = false
    const before = listCalls().length
    await advance(9_000)
    expect(listCalls().length).toBe(before)
    expect(screen.getByText('The list could not load. Retrying…')).toBeInTheDocument()

    await advance(1_500)
    expect(await screen.findByText('Default bill')).toBeInTheDocument()
    expect(screen.queryByText('The list could not load. Retrying…')).toBeNull()
    expect(screen.queryByText(/internal_error|database_overloaded/)).toBeNull()
    expect(listCalls().length).toBe(before + 1)
  })

  it('retries only once: a second 503 says so and stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    net.listOverloaded = true
    renderPage()
    expect(await screen.findByText('The list could not load. Retrying…')).toBeInTheDocument()
    const before = listCalls().length
    await advance(11_000)
    await waitFor(() => expect(screen.queryByText('The list could not load. Retrying…')).toBeNull())
    expect(listCalls().length).toBe(before + 1)
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i)
    expect(screen.queryByText(/internal_error|database_overloaded/)).toBeNull()
    await advance(60_000)
    expect(listCalls().length).toBe(before + 1)
  })

  it('does not retry after the page is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    net.listOverloaded = true
    renderPage()
    expect(await screen.findByText('The list could not load. Retrying…')).toBeInTheDocument()
    const before = listCalls().length
    cleanup()
    await advance(30_000)
    expect(listCalls().length).toBe(before)
  })

  it('leaves a 500 as the plain failure: no retry message, no retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/api/, '')
      if (path.startsWith('/bills?')) { net.calls.push(path); return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500, headers: { 'Content-Type': 'application/json' } }) }
      return fakeFetch(input)
    }))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('internal_error')
    expect(screen.queryByText('The list could not load. Retrying…')).toBeNull()
    const before = listCalls().length
    await advance(30_000)
    expect(listCalls().length).toBe(before)
  })
})

describe('the filter menus when the database is overloaded', () => {
  const subjectButton = () => screen.getAllByRole('button', { name: /^Subject/ }).find(b => !b.textContent?.includes('▲'))!

  it('shows the failed state on a 503 and asks again the next time the menu is opened', async () => {
    net.menuOverloaded = true
    renderPage()
    await screen.findByText('Default bill')
    fireEvent.click(subjectButton())
    await waitFor(() => expect(net.calls.filter(isLazyFacetsCall)).toHaveLength(1))
    await act(async () => {})
    const menu = screen.getByRole('group', { name: 'Subject' })
    expect(within(menu).getByText('Couldn’t load subjects.')).toBeInTheDocument()
    expect(screen.getByText('Default bill')).toBeInTheDocument()
    expect(screen.queryByText(/internal_error|database_overloaded|Failed to load bills/)).toBeNull()

    net.menuOverloaded = false
    fireEvent.click(subjectButton()) // close
    fireEvent.click(subjectButton()) // reopen
    await waitFor(() => expect(net.calls.filter(isLazyFacetsCall)).toHaveLength(2))
    expect(await within(screen.getByRole('group', { name: 'Subject' })).findByText('Roads')).toBeInTheDocument()
  })
})
