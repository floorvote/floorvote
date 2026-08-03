import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'

// Renders the current pathname + hash so navigation tests can assert where a
// click landed (including the #section-* anchor on the bill detail page).
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}{loc.hash}</div>
}

// --- Mock the API client ----------------------------------------------------
// BillList (and the AuthProvider it renders under) talk to the backend only
// through apiFetch. We route by path and record the calls so we can assert the
// list both renders the fixture and re-fetches when a filter changes.
const apiCalls: string[] = []

// Lets a test hold the `/bills/:id` prefetch open so it can observe the
// navigation-pending window (when the body should carry the wait-cursor class).
const deferred: {
  resolveBillDetail: ((v: unknown) => void) | null
  rejectVote: ((reason?: unknown) => void) | null
} = { resolveBillDetail: null, rejectVote: null }

// Lets a test force the vote endpoint to reject so we can assert the optimistic
// vote rolls back.
const voteReject = { value: false }

const CONFIG = {
  associationName: 'Test Assoc',
  states: ['RI'],
  positionVocabulary: ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'],
  orgNoun: 'association',
}

function makeBill(over: Partial<Record<string, unknown>>) {
  return {
    id: 'b1', billNumber: 'HB 1', title: 'Default bill', state: 'RI', status: '2',
    session: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: 'Referred',
    lastActionDate: '2026-02-01', tenantSummary: null, tags: [], priority: null,
    matchType: 'keyword', position: null, relevanceScore: 80, aiProcessedAt: null,
    voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-02-01 10:00:00',
    customFieldValues: {},
    ...over,
  }
}

const BILLS = [
  makeBill({ id: 'bill-early-vote', billNumber: 'SB 2218', title: 'Early Voting Centers', status: '2', commentCount: 2, hasNote: true }),
  makeBill({ id: 'bill-voter-id', billNumber: 'HB 5042', title: 'Voter Identification Requirements', status: '1' }),
  makeBill({ id: 'bill-training', billNumber: 'SB 2500', title: 'Election Official Training', status: '4' }),
]

const FACETS = {
  status: { '1': 1, '2': 1, '4': 1 },
  priority: {},
  session: {},
  year: {},
  state: { RI: 3 },
  position: {},
  tags: {},
  customFields: {},
  myBillsCount: 0,
  newMatchesCount: 0,
}

vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'ApiError' }
  }
  async function apiFetch<T>(path: string): Promise<T> {
    apiCalls.push(path)
    if (path === '/auth/me') {
      return { id: 'demo-user', email: 'demo@example.com', name: 'Demo', role: 'owner',
        subtitle: null, canVote: true, emailDigestEnabled: false, lastSeenFeed: null } as T
    }
    if (path === '/config') return CONFIG as T
    if (path === '/users/me/bills') return [] as T
    if (path === '/config/custom-fields') return [] as T
    if (path.startsWith('/bills/facets')) return FACETS as T
    if (path.endsWith('/votes')) {
      // When a test wants the vote to fail, hold the rejection open (deferred) so
      // the optimistic count stays observable until the test triggers the failure
      // — otherwise the rollback can beat the assertion on a loaded CI runner.
      if (voteReject.value) {
        return new Promise<T>((_resolve, reject) => { deferred.rejectVote = reject })
      }
      return {} as T
    }
    // A single-bill prefetch (e.g. /bills/bill-early-vote) — held open so a
    // test can inspect state while navigation is pending.
    if (/^\/bills\/[^?]/.test(path)) {
      return new Promise<T>(res => { deferred.resolveBillDetail = res as (v: unknown) => void })
    }
    if (path.startsWith('/bills?')) {
      // Honor a status filter so the test can observe the list responding.
      const qs = new URLSearchParams(path.split('?')[1])
      const statuses = qs.getAll('status')
      const filtered = statuses.length > 0 ? BILLS.filter(b => statuses.includes(b.status)) : BILLS
      return { bills: filtered, pagination: { page: 1, pageSize: 100, total: filtered.length, totalPages: 1 } } as T
    }
    return {} as T
  }
  return { apiFetch, ApiError }
})

// --- Mock the virtualizer ---------------------------------------------------
// jsdom has no layout, so the real useVirtualizer measures a 0-height scroll
// element and renders no rows. Render every row instead so we can assert on it.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 150,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index, key: index, start: index * 150, size: 150,
      })),
    measureElement: () => {},
  }),
}))

import { BillList } from './index'
import { ApiError } from '../../lib/api'
import { AuthProvider } from '../../context/AuthContext'
import { SidebarRefreshProvider } from '../../context/SidebarRefreshContext'

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/bills']}>
      <AuthProvider>
        <SidebarRefreshProvider>{children}</SidebarRefreshProvider>
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>
  )
}

// Stub IntersectionObserver (infinite-scroll sentinel) — absent in jsdom.
// Use vi.stubGlobal so afterEach's unstubAllGlobals actually restores it
// (a direct globalThis assignment would leak into other test files).
class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  apiCalls.length = 0
  deferred.resolveBillDetail = null
  deferred.rejectVote = null
  voteReject.value = false
  document.body.classList.remove('nav-pending')
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BillList vote failure rollback', () => {
  it('rolls back the optimistic vote when the vote request fails', async () => {
    voteReject.value = true
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    // First bill (Early Voting Centers) — its Support vote button + count.
    // Re-resolve the row on each check rather than caching the node: an optimistic
    // re-render can replace the row's DOM element, so a reference captured once can
    // go stale (an intermittent "unable to find 1/0" under load).
    const supportRow = () => screen.getAllByRole('button', { name: 'Support' })[0].parentElement!.parentElement!
    expect(within(supportRow()).getByText('0')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Support' })[0])
    // Optimistic update bumps the count to 1 (the failing vote request is held
    // pending by the mock, so the count stays observably at 1)...
    await waitFor(() => expect(within(supportRow()).getByText('1')).toBeInTheDocument())
    // ...now fail the request; the count must roll back to 0.
    deferred.rejectVote?.(new ApiError(500, 'fail'))
    await waitFor(() => expect(within(supportRow()).getByText('0')).toBeInTheDocument())
  })
})

describe('BillList page', () => {
  it('renders the seeded bills from the API', async () => {
    render(<BillList />, { wrapper: Wrapper })

    expect(await screen.findByText('Early Voting Centers')).toBeInTheDocument()
    expect(screen.getByText('Voter Identification Requirements')).toBeInTheDocument()
    expect(screen.getByText('Election Official Training')).toBeInTheDocument()

    // Bill count reflects the full fixture.
    expect(await screen.findByText(/3 bills/)).toBeInTheDocument()

    // Column headers are fixed labels regardless of org noun.
    // The SortHeader buttons include the sort arrow indicator after the label.
    expect(screen.getAllByRole('button', { name: /^Position/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /^Relevance/ }).length).toBeGreaterThan(0)

    // Sort description uses the configured org noun via orgPositionLabel.
    // Default sort shows the full hierarchy including the position label.
    expect(screen.getByText(/Sorted by:/)).toBeInTheDocument()
  })

  it('re-fetches and narrows the list when a status filter is applied', async () => {
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    // Open the Status filter dropdown and pick "Passed" (LegiScan code 4),
    // which only the training bill has.
    // The filter dropdown button's accessible name is exactly "Status"
    // (the sortable column header is "Status ▲▼", so an exact match disambiguates).
    fireEvent.click(screen.getByRole('button', { name: 'Status' }))
    // "Passed" also appears on a row's status chip, so pick the dropdown option
    // specifically: the one rendered inside a <label> (checkbox row).
    const passedOption = (await screen.findAllByText('Passed'))
      .find(el => el.closest('label') !== null)
    expect(passedOption).toBeTruthy()
    fireEvent.click(passedOption!)

    // The list re-queries /bills with status=4 ...
    await waitFor(() => {
      expect(apiCalls.some(c => c.startsWith('/bills?') && c.includes('status=4'))).toBe(true)
    })

    // ... and the other two bills drop out of the list.
    await waitFor(() => {
      expect(screen.queryByText('Early Voting Centers')).toBeNull()
    })
    expect(screen.getByText('Election Official Training')).toBeInTheDocument()
  })

  // (The "nav-pending while opening a bill" test was removed with the custom nav
  // layer — the wait cursor is now driven by the router's navigation state via
  // useNavPendingCursor; see useNavPendingCursor.test.tsx. Clicking a bill now
  // navigates straight through the router, so the indicator tests below no longer
  // hold a prefetch open.)

  it('comment indicator navigates to the bill comments section', async () => {
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    fireEvent.click(screen.getByRole('button', { name: /2 comments/ }))

    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toContain('#section-comments')
    })
  })

  it('personal note indicator navigates to the bill note section', async () => {
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    fireEvent.click(screen.getByRole('button', { name: /Personal note/ }))

    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toContain('#section-note')
    })
  })
})

describe('BillList search-term hint', () => {
  it('warns when a search term is too long, and clears it otherwise', async () => {
    render(<Wrapper><BillList /></Wrapper>)
    await screen.findByText('Early Voting Centers')   // fixture list loaded
    const search = screen.getByPlaceholderText('Search…')

    fireEvent.change(search, { target: { value: 'a'.repeat(60) } })
    expect(screen.getByText(/shortened/i)).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'voting' } })
    expect(screen.queryByText(/shortened/i)).not.toBeInTheDocument()
  })

  it('warns when there are too many search terms', async () => {
    render(<Wrapper><BillList /></Wrapper>)
    await screen.findByText('Early Voting Centers')
    const search = screen.getByPlaceholderText('Search…')

    fireEvent.change(search, { target: { value: Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ') } })
    expect(screen.getByText(/first 12 terms/i)).toBeInTheDocument()
  })
})
