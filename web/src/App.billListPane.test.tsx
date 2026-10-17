import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'

// The split pane is AppLayout's, so this mounts the real route tree with light
// page stubs (as App.layout.test.tsx does) and the real BillListPane.
vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ containerRef }: { containerRef: { current: HTMLElement | null } }) => <aside data-testid="sidebar" ref={containerRef} />,
}))
vi.mock('./components/MobileTopBar', () => ({ MobileTopBar: () => null }))
vi.mock('./pages/Feed', () => ({ Feed: () => <div>feed page</div>, FeedPane: () => <div>feed page</div>, feedLoader: () => null }))
vi.mock('./pages/BillList', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pages/BillList')>()),
  BillList: () => <div>bills page</div>,
  billListLoader: () => null,
}))
vi.mock('./pages/BillDetail', () => ({
  BillDetail: function DetailStub() { return <div>detail {useLocation().pathname}</div> },
  billDetailLoader: () => null,
}))

const hoisted = vi.hoisted(() => ({ calls: [] as string[] }))

function bill(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `b${n}`, billNumber: `HB ${n}`, title: `Bill number ${n}`, state: 'RI', status: 'Introduced',
    session: '2026', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null, lastActionDate: null, tenantSummary: null,
    tags: [], priority: null, matchType: null, position: null, relevanceScore: null, aiProcessedAt: null,
    newMatchAt: null, triagedAt: null, voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-01-01 00:00:00', ...extra,
  }
}

vi.mock('./lib/api', () => ({
  apiFetch: async (path: string) => {
    hoisted.calls.push(path)
    if (path === '/auth/me') {
      return { id: 'u1', email: 'a@b.c', name: 'A', role: 'owner', subtitle: null, canVote: true, emailDigestEnabled: false, lastSeenFeed: null }
    }
    if (path === '/views') return { views: [{ id: 'v1', slug: 'urgent', name: 'Urgent', query: 'priority=high&sort=bill&dir=desc' }] }
    if (path.startsWith('/bills?')) {
      return {
        bills: [bill(1), bill(2, { priority: 'high' }), bill(3, { isDraft: true, title: 'Draft three' })],
        pagination: { page: 1, pageSize: 100, total: 3, totalPages: 1 },
      }
    }
    return {}
  },
  ApiError: class ApiError extends Error {},
}))

import { routes } from './App'
import { AuthProvider } from './context/AuthContext'

const realMatchMedia = window.matchMedia
const realScroll = Element.prototype.scrollIntoView
function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query)
    const max = /max-width:\s*(\d+)px/.exec(query)
    const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }
  }) as unknown as typeof window.matchMedia
}

// Initial entries are percent-encoded, as a browser's location.pathname is for
// a bill number with a space ("HB 2"); the pane must still find the current bill.
function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
  return router
}

beforeEach(() => {
  hoisted.calls = []
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { window.matchMedia = realMatchMedia; Element.prototype.scrollIntoView = realScroll })

describe('bill list beside a bill (split pane)', () => {
  it('shows no list on a narrower viewport — the bill page is unchanged', async () => {
    setViewport(1200)
    renderAt('/RI/2026/HB%202')
    expect(await screen.findByText('detail /RI/2026/HB%202')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Bill list' })).toBeNull()
    expect(hoisted.calls.some(c => c.startsWith('/bills?'))).toBe(false)
  })

  it('shows the list beside the bill on a wide viewport and marks the current bill', async () => {
    setViewport(1440)
    renderAt('/RI/2026/HB%202')
    expect(await screen.findByText('detail /RI/2026/HB%202')).toBeInTheDocument()
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Bill number 1')

    const current = within(pane).getByRole('link', { current: 'page' })
    expect(current).toHaveAttribute('href', '/RI/2026/HB 2')
    expect(current).toHaveTextContent('Bill number 2')
    expect(current).toHaveTextContent('high priority')
    expect(within(pane).getByRole('link', { name: /Bill number 1/ })).not.toHaveAttribute('aria-current')
    expect(within(pane).getByRole('link', { name: /Draft three/ })).toHaveTextContent('Draft')
    // Pane comes before <main> in the DOM, matching its place on screen.
    expect(pane.compareDocumentPosition(document.getElementById('main-content')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('lets the reader resize the list on a wide viewport, and stores the width', async () => {
    setViewport(1600)
    const realInner = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 })
    try {
      localStorage.clear()
      renderAt('/RI/2026/HB%202')
      const pane = await screen.findByRole('navigation', { name: 'Bill list' })
      await within(pane).findByText('Bill number 1')
      const sep = within(pane).getByRole('separator', { name: 'Resize bill list' })
      expect(pane.style.width).toBe('300px')
      fireEvent.keyDown(sep, { key: 'End' })
      expect(pane.style.width).toBe('670px')
      expect(localStorage.getItem('billListPaneWidth')).toBe('670')
    } finally {
      localStorage.clear()
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: realInner })
    }
  })

  it('has no resize handle where there is no list', async () => {
    setViewport(1200)
    renderAt('/RI/2026/HB%202')
    expect(await screen.findByText('detail /RI/2026/HB%202')).toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize bill list' })).toBeNull()
  })

  it('is not shown on the Bills page itself', async () => {
    setViewport(1600)
    renderAt('/bills')
    expect(await screen.findByText('bills page')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Bill list' })).toBeNull()
  })

  it('uses the filters and sort the Bills page last had', async () => {
    setViewport(1440)
    sessionStorage.setItem('lastBillsUrl', '/bills?status=Introduced&priority=high&sort=bill&dir=desc')
    renderAt('/RI/2026/HB%201')
    await screen.findByRole('navigation', { name: 'Bill list' })
    await waitFor(() => expect(hoisted.calls.some(c => c.startsWith('/bills?'))).toBe(true))
    const q = new URLSearchParams(hoisted.calls.find(c => c.startsWith('/bills?'))!.slice('/bills?'.length))
    expect(q.getAll('status')).toEqual(['Introduced'])
    expect(q.getAll('priority')).toEqual(['high'])
    expect(q.get('sort')).toBe('bill')
    expect(q.get('dir')).toBe('desc')
    expect(screen.getByRole('link', { name: 'Bills' })).toHaveAttribute('href', '/bills?status=Introduced&priority=high&sort=bill&dir=desc')
  })

  it('expands a saved view left in its short ?view= form', async () => {
    setViewport(1440)
    sessionStorage.setItem('lastBillsUrl', '/bills?view=urgent')
    renderAt('/RI/2026/HB%201')
    await screen.findByRole('navigation', { name: 'Bill list' })
    await waitFor(() => expect(hoisted.calls.some(c => c.startsWith('/bills?'))).toBe(true))
    expect(hoisted.calls).toContain('/views')
    const q = new URLSearchParams(hoisted.calls.find(c => c.startsWith('/bills?'))!.slice('/bills?'.length))
    expect(q.getAll('priority')).toEqual(['high'])
    expect(q.get('sort')).toBe('bill')
  })

  it('navigates to the clicked bill’s own URL and keeps the same list', async () => {
    setViewport(1440)
    const router = renderAt('/RI/2026/HB%201')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Bill number 1')

    fireEvent.click(within(pane).getByRole('link', { name: /Bill number 2/ }))
    expect(await screen.findByText('detail /RI/2026/HB 2')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/RI/2026/HB 2')
    // BillDetail's previous/next controls walk the pane's order.
    expect(router.state.location.state).toEqual({ billPaths: ['/RI/2026/HB 1', '/RI/2026/HB 2', '/RI/2026/HB 3'], currentIndex: 1 })

    // Same pane element (not remounted), no refetch, highlight moved.
    expect(screen.getByRole('navigation', { name: 'Bill list' })).toBe(pane)
    expect(hoisted.calls.filter(c => c.startsWith('/bills?'))).toHaveLength(1)
    expect(within(pane).getByRole('link', { current: 'page' })).toHaveAttribute('href', '/RI/2026/HB 2')
  })

  // The legacy /bills/:billId route carries the pane too, and a reader can move
  // between it and the canonical shape without the pane remounting.
  it('shows the list on the legacy /bills/:id route and marks the bill by its id', async () => {
    setViewport(1440)
    renderAt('/bills/b2')
    expect(await screen.findByText('detail /bills/b2')).toBeInTheDocument()
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Bill number 1')
    const current = within(pane).getByRole('link', { current: 'page' })
    expect(current).toHaveTextContent('Bill number 2')
    expect(current).toHaveAttribute('href', '/RI/2026/HB 2')
  })

  it('keeps the same pane when the legacy route moves to a canonical bill URL', async () => {
    setViewport(1440)
    const router = renderAt('/bills/b2')
    const pane = await screen.findByRole('navigation', { name: 'Bill list' })
    await within(pane).findByText('Bill number 1')

    fireEvent.click(within(pane).getByRole('link', { name: /Draft three/ }))
    expect(await screen.findByText('detail /RI/2026/HB 3')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/RI/2026/HB 3')
    expect(screen.getByRole('navigation', { name: 'Bill list' })).toBe(pane)
    expect(hoisted.calls.filter(c => c.startsWith('/bills?'))).toHaveLength(1)
    expect(within(pane).getByRole('link', { current: 'page' })).toHaveTextContent('Draft three')
  })

  it('shows the list on the legacy /:session/:bill route', async () => {
    setViewport(1440)
    renderAt('/2026/HB%202')
    expect(await screen.findByText('detail /2026/HB%202')).toBeInTheDocument()
    expect(await screen.findByRole('navigation', { name: 'Bill list' })).toBeInTheDocument()
  })
})
