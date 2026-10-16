import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const apiCalls: string[] = []
const holdBills = vi.hoisted(() => ({ value: false }))
const CF_DEFS = [
  { id: 'cf-acet-uuid', name: 'ACET is tracking', slug: 'acet_is_tracking', type: 'binary', options: null, displayOrder: 1 },
]
const BILL = {
  id: 'b1', billNumber: 'HB 1', title: 'Early Voting Centers', state: 'RI', status: '2',
  session: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026, abstract: null, url: null,
  stateUrl: null, lastAction: 'Referred', lastActionDate: '2026-02-01', tenantSummary: null, tags: [],
  priority: null, matchType: 'keyword', position: null, relevanceScore: 80, aiProcessedAt: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null, commentCount: 0, hasNote: false,
  hasComment: false, updatedAt: '2026-02-01 10:00:00', customFieldValues: {},
}

vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'ApiError' }
  }
  async function apiFetch<T>(path: string): Promise<T> {
    apiCalls.push(path)
    if (path === '/auth/me') {
      return { id: 'u', email: 'u@example.com', name: 'U', role: 'owner', title: null, canVote: true,
        emailDigestEnabled: false, lastSeenFeed: null } as T
    }
    if (path === '/config') {
      return { associationName: 'Test', states: ['RI'], positionVocabulary: ['Support'], orgNoun: 'association' } as T
    }
    if (path === '/users/me/bills') return [] as T
    if (path === '/config/custom-fields') return CF_DEFS as T
    if (path === '/views') return { views: [] } as T
    if (path.startsWith('/bills/facets')) {
      return { status: {}, priority: {}, session: {}, year: {}, state: {}, position: {}, tags: {}, subjects: {},
        customFields: {}, myBillsCount: 0, newMatchesCount: 0 } as T
    }
    if (path.startsWith('/bills?')) {
      if (holdBills.value) return new Promise<T>(() => {})
      return { bills: [BILL], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } } as T
    }
    return {} as T
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

import { BillList, billListLoader } from './index'
import { AuthProvider } from '../../context/AuthContext'
import { SidebarRefreshProvider } from '../../context/SidebarRefreshContext'

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  apiCalls.length = 0
  holdBills.value = false
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('bill list prefetch with a custom-field filter', () => {
  it('paints the prefetched first page without waiting on its own bills request', async () => {
    // A visit earlier in the session leaves the custom-field defs cached, so the
    // next mount resolves slugs to ids on its very first render.
    const first = render(
      <MemoryRouter initialEntries={['/bills']}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByText('Early Voting Centers')
    await waitFor(() => expect(apiCalls).toContain('/config/custom-fields'))
    await new Promise(r => setTimeout(r, 50))
    first.unmount()

    const url = '/bills?cf_acet_is_tracking=1'
    await billListLoader({ params: {}, request: new Request(`http://localhost${url}`), context: {} } as never)

    // From here on the list's own bills fetch never answers, so the only way
    // the rows can appear is by reusing the page the loader already fetched.
    holdBills.value = true
    render(
      <MemoryRouter initialEntries={[url]}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Early Voting Centers')).toBeInTheDocument()
  })
})
