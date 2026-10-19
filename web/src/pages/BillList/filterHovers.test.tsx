// The Bills page filter bar's hover bubbles. A bubble that only restates the
// control's own label ("Filter by state" on a State dropdown) adds nothing and
// is gone; the ones that say what a control does beyond its label stay.
// Harness adapted from scopeCluster.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

const authState = vi.hoisted(() => ({ role: 'member' as 'member' | 'admin' }))

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }),
}))

const CONFIG = {
  associationName: 'Test Assoc',
  states: ['RI', 'MA'],
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
        title: null, canVote: true, emailDigestEnabled: false, lastSeenFeed: null } as T
    }
    if (path === '/config') return CONFIG as T
    if (path === '/users/me/bills') return [] as T
    if (path === '/config/custom-fields') return [] as T
    if (path.startsWith('/bills/facets')) {
      return {
        status: { '2': 1 }, priority: { high: 1 }, sessionName: {}, year: { '2025': 1 }, state: { RI: 1, MA: 1 }, position: { Support: 1 },
        tag: { Clerk: 1 }, subject: {}, field: {}, myBillsCount: 2, newMatchesCount: 3,
        unvotedCount: 7, hasDrafts: true, draftCount: 1,
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


const hover = (el: HTMLElement) => fireEvent.pointerEnter(el, { pointerType: 'mouse' })
const bubbles = () => Array.from(document.body.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')).filter(e => e.style.position === 'fixed')

describe('Bills page filter bar hovers', () => {
  const REMOVED: [string, RegExp][] = [
    ['State', /^State/],
    ['Session year', /^Session year/],
    ['Position', /^Position/],
    ['Priority', /^Priority/],
  ]
  it.each(REMOVED)('shows no bubble over the %s dropdown, which only restated its label', async (_name, label) => {
    await renderBillList({ isAdmin: true })
    // The column headers of the table are sort buttons (they carry a ▲▼), not filters.
    const btn = await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: label }).find(b => !b.textContent?.includes('▲'))
      if (!found) throw new Error(`no ${_name} filter button yet`)
      return found
    })
    hover(btn)
    expect(bubbles()).toHaveLength(0)
    expect(screen.queryByText(/^Filter by (state|legislative|your|AI)/)).not.toBeInTheDocument()
  })

  it('shows no bubble over Not yet voted, which only restated it', async () => {
    await renderBillList({ isAdmin: true })
    hover(screen.getByRole('button', { name: /not yet voted/i }))
    expect(bubbles()).toHaveLength(0)
  })

  const KEPT: [string, RegExp, string][] = [
    ['My bills', /my bills/i, "Show only bills you've voted on, commented on, or noted"],
    ['New matches', /new matches/i, 'Show only newly keyword-matched bills awaiting a priority decision'],
    ['Tag', /^Tag/, "Filter by your team's AI-generated tags"],
    ['Drafts', /drafts/i, 'Show only draft bills — pre-filed, not yet introduced'],
  ]
  it('still says over the Relevance slider that the score is AI-generated', async () => {
    await renderBillList({ isAdmin: true })
    hover(screen.getByRole('slider'))
    expect(screen.getByText('Filter by AI-scored relevance to your association')).toBeInTheDocument()
  })

  it.each(KEPT)('still explains %s, which says more than its label', async (_name, label, text) => {
    await renderBillList({ isAdmin: true })
    hover(screen.getByRole('button', { name: label }))
    expect(screen.getByText(text)).toBeInTheDocument()
  })
})
