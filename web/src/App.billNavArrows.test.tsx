import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// The previous/next arrows must be up and down in the real app layout, both
// with the bill list beside the bill (split pane, wide viewport) and without it.
// This mounts the real route tree and the real BillDetail; only the sidebar,
// top bar, and rich text editor are stubbed.
vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ containerRef }: { containerRef: { current: HTMLElement | null } }) => <aside data-testid="sidebar" ref={containerRef} />,
}))
vi.mock('./components/MobileTopBar', () => ({ MobileTopBar: () => null }))
vi.mock('./components/RichTextEditor', () => ({ RichTextEditor: () => null }))
vi.mock('./pages/Feed', () => ({ Feed: () => <div>feed page</div>, FeedPane: () => <div>feed page</div>, feedLoader: () => null }))
vi.mock('./pages/BillList', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pages/BillList')>()),
  BillList: () => <div>bills page</div>,
  billListLoader: () => null,
}))
vi.mock('./lib/scrollUtils', () => ({ getScrollContainer: () => ({ scrollTo: () => {} }) }))

const BILL = {
  id: '42',
  externalId: 'legiscan:42',
  billNumber: 'HB 1',
  title: 'Test Bill',
  state: 'RI',
  status: 'Introduced',
  statusDate: null,
  session: '2025-2026',
  sessionId: '1',
  sessionSlug: '2025-2026',
  yearStart: 2025,
  yearEnd: 2026,
  description: null,
  billType: null,
  body: null,
  currentBody: null,
  abstract: null,
  stateLink: null,
  stateUrl: null,
  url: null,
  legiscanUrl: null,
  committee: null,
  referrals: [],
  tenantSummary: 'This bill does things.',
  tags: [],
  relevanceScore: 85,
  priority: null,
  textR2Key: null,
  sponsor: null,
  sponsorParty: null,
  sponsorUrl: null,
  coSponsors: [],
  lastAction: null,
  lastActionDate: null,
  history: [],
  voteSummary: [],
  subjects: [],
  relatedBillIds: [],
  companionBillIds: [],
  texts: [],
  calendar: [],
  supplements: [],
  amendments: [],
  customFieldValues: {},
  matchType: 'keyword' as const,
  isDraft: false,
  draftText: null,
  createdAt: '2025-01-01 00:00:00',
  updatedAt: '2025-01-01 00:00:00',
  centralSyncedAt: null,
  aiProcessedAt: null,
  aiSkipReason: null,
  lastAiTextDocId: null,
  textStatus: 'not_checked' as const,
  myVote: null,
  myNote: 'A private note',
  priorityMeta: null,
  position: { position: 'support', setByName: 'Admin', updatedAt: '2025-01-01 00:00:00' },
  voteCounts: { support: 1, oppose: 0, neutral: 0, total: 1 },
  memberVotes: [],
  comments: [],
  commentsTotal: 0,
}


const PATHS = ['/RI/2026/HB 1', '/RI/2026/HB 2', '/RI/2026/HB 3']

function listBill(n: number) {
  return {
    id: `b${n}`, billNumber: `HB ${n}`, title: `Bill number ${n}`, state: 'RI', status: 'Introduced',
    session: '2026', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null, lastActionDate: null, tenantSummary: null,
    tags: [], priority: null, matchType: null, position: null, relevanceScore: null, aiProcessedAt: null,
    newMatchAt: null, triagedAt: null, voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-01-01 00:00:00',
  }
}

function answer(path: string): unknown {
  if (path === '/auth/me') {
    return { id: 'u1', email: 'a@b.c', name: 'A', role: 'owner', canVote: true, emailDigestEnabled: false, lastSeenFeed: null }
  }
  if (path === '/views') return { views: [] }
  if (path.startsWith('/bills?')) {
    return { bills: [1, 2, 3].map(listBill), pagination: { page: 1, pageSize: 100, total: 3, totalPages: 1 } }
  }
  if (path.startsWith('/bills/resolve/')) {
    const n = /HB(?:%20|\s)?(\d)/.exec(path)?.[1] ?? '2'
    return { ...BILL, id: `b${n}`, billNumber: `HB ${n}`, title: `Bill number ${n}` }
  }
  if (path === '/config') return { associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'], states: ['RI'], instanceDomains: {}, orgNoun: 'association' }
  if (path === '/config/custom-fields') return []
  if (path.startsWith('/bills/labels')) return { state: 'RI', statuses: [], billTypes: [], eventTypes: [], calendarName: null, hasEvents: false }
  return {}
}

vi.mock('./lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api')>()),
  apiFetch: async (path: string) => answer(path),
  apiFetchForLoader: async (path: string) => answer(path),
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

function renderAt(pathname: string, currentIndex: number) {
  const router = createMemoryRouter(routes, {
    initialEntries: [{ pathname, state: { billPaths: PATHS, currentIndex } }],
  })
  render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
  return router
}

beforeEach(() => {
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { window.matchMedia = realMatchMedia; Element.prototype.scrollIntoView = realScroll })

describe.each([
  { layout: 'split pane beside the bill list', width: 1440, hasPane: true },
  { layout: 'full layout, no bill list', width: 1200, hasPane: false },
])('bill page arrows in the real app layout: $layout', ({ width, hasPane }) => {
  beforeEach(() => setViewport(width))

  it('shows an up arrow for the previous bill and a down arrow for the next', async () => {
    renderAt('/RI/2026/HB%202', 1)
    await screen.findByText('Introduced', { selector: 'main *' })
    if (hasPane) await screen.findByRole('navigation', { name: 'Bill list' })
    else expect(screen.queryByRole('navigation', { name: 'Bill list' })).toBeNull()
    const prev = await screen.findByRole('button', { name: 'Previous bill' })
    const next = screen.getByRole('button', { name: 'Next bill' })
    expect(prev.querySelector('svg[data-arrow="up"]')).not.toBeNull()
    expect(next.querySelector('svg[data-arrow="down"]')).not.toBeNull()
    expect(prev.textContent).not.toMatch(/[←→]/)
    expect(next.textContent).not.toMatch(/[←→]/)
  })

  it('steps through the list with the arrows (down goes to the next bill)', async () => {
    const router = renderAt('/RI/2026/HB%202', 1)
    const next = await screen.findByRole('button', { name: 'Next bill' })
    next.click()
    await waitFor(() => expect(router.state.location.pathname).toBe('/RI/2026/HB 3'))
    // On the last bill the down arrow is disabled and the up arrow is not.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next bill' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Previous bill' })).toBeEnabled()
  })
})
