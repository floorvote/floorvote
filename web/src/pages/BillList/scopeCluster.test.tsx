// Task 7: viewer-scope filters (My bills, New matches, Not yet voted) live in
// a cluster beside the search box, behind a separator, entirely apart from
// the chip row's bill-fact dimensions and its AND/OR group operator. See
// activeFilterGroups.tsx and lib/filterDimensions.ts for why: an operator
// must never appear to govern a filter it doesn't govern.
//
// Harness adapted from filterDimensionParity.test.tsx (mutable authState.role
// drives isAdmin) with an added initialUrl option, since this suite also
// needs to drive scope filters directly from the URL.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

const authState = vi.hoisted(() => ({ role: 'member' as 'member' | 'admin' }))

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }),
}))

const CONFIG = {
  associationName: 'Test Assoc',
  states: ['RI'],
  positionVocabulary: ['Support', 'Oppose'],
  orgNoun: 'association',
}

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

vi.mock('../../lib/api', () => {
  async function apiFetch<T>(path: string): Promise<T> {
    if (path === '/auth/me') {
      return { id: 'u1', email: 'u1@example.com', name: 'U1', role: authState.role,
        subtitle: null, canVote: true, emailDigestEnabled: false, lastSeenFeed: null } as T
    }
    if (path === '/config') return CONFIG as T
    if (path === '/users/me/bills') return [] as T
    if (path === '/config/custom-fields') return [] as T
    if (path.startsWith('/bills/facets')) {
      return {
        status: { '2': 1 }, priority: {}, session: {}, year: {}, state: { RI: 1 }, position: {},
        tags: { Clerk: 1 }, subjects: {}, customFields: {}, myBillsCount: 2, newMatchesCount: 3,
      } as T
    }
    if (path.startsWith('/bills?')) {
      return { bills: [BILL], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } } as T
    }
    return {} as T
  }
  class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'ApiError' }
  }
  return { apiFetch, ApiError }
})

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 150,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 150, size: 150 })),
    measureElement: () => {},
  }),
}))

import { BillList } from './index'
import { AuthProvider } from '../../context/AuthContext'
import { SidebarRefreshProvider } from '../../context/SidebarRefreshContext'

function Wrapper({ children, initialUrl }: { children: ReactNode; initialUrl: string }) {
  return (
    <MemoryRouter initialEntries={[initialUrl]}>
      <AuthProvider>
        <SidebarRefreshProvider>{children}</SidebarRefreshProvider>
      </AuthProvider>
    </MemoryRouter>
  )
}

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  authState.role = 'member'
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  // Unmount before the next file runs. Without this the rendered tree leaks
  // into whichever suite vitest schedules next in this worker, and the first
  // test there finds two BillLists in the document — which is exactly how
  // index.test.tsx's saved-views case failed when this file was ported.
  cleanup()
  vi.unstubAllGlobals()
})

async function renderBillList({ isAdmin = false, initialUrl = '/bills' }: { isAdmin?: boolean; initialUrl?: string } = {}) {
  authState.role = isAdmin ? 'admin' : 'member'
  render(<BillList />, { wrapper: (props) => <Wrapper {...props} initialUrl={initialUrl} /> })
  await screen.findByText('Default bill')
}

describe('scope cluster', () => {
  it('places every scope control before any dimension control', async () => {
    await renderBillList({ isAdmin: true })
    const order = screen.getAllByRole('button').map(b => b.textContent ?? '')
    const lastScope = Math.max(
      order.findIndex(t => t.includes('My bills')),
      order.findIndex(t => t.includes('New matches')),
      order.findIndex(t => t.includes('Not yet voted')),
    )
    const firstDimension = order.findIndex(t => t.includes('Status'))
    expect(lastScope).toBeGreaterThanOrEqual(0)
    expect(firstDimension).toBeGreaterThanOrEqual(0)
    expect(lastScope).toBeLessThan(firstDimension)
  })

  it('offers a Not yet voted toggle, which the bills page previously could not set', async () => {
    await renderBillList({})
    expect(screen.getByRole('button', { name: /not yet voted/i })).toBeInTheDocument()
  })

  it('separates the cluster from the dimensions', async () => {
    await renderBillList({})
    expect(screen.getByTestId('scope-separator')).toBeInTheDocument()
  })

  it('does not render scope filters as chips', async () => {
    await renderBillList({ initialUrl: '/bills?unvoted=1&newMatches=1&tag=Clerk' })
    const chipRow = screen.getByTestId('active-filter-chips')
    expect(chipRow).not.toHaveTextContent('Not yet voted')
    expect(chipRow).not.toHaveTextContent('New matches')
    expect(chipRow).toHaveTextContent('Clerk')
  })

  it('keeps the operator out of a row with one group', async () => {
    await renderBillList({ initialUrl: '/bills?unvoted=1&tag=Clerk' })
    // unvoted is scope, so this is a single group: no operator.
    expect(screen.queryByRole('button', { name: /^and$/i })).not.toBeInTheDocument()
  })

  it('does not open the chip row at all when only scope filters are active', async () => {
    await renderBillList({ initialUrl: '/bills?unvoted=1&newMatches=1' })
    expect(screen.queryByTestId('active-filter-chips')).not.toBeInTheDocument()
  })
})
