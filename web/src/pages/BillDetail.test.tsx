import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// ── Route params (mutable so individual tests can vary route + nav state) ──────
const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' } as {
    state: unknown; pathname: string; hash: string; search: string
  },
  // The route loader runs before render in the real app; when rendering BillDetail
  // directly we feed its result through this (set by makeMockApiFetch).
  loaderData: null as unknown,
}))
function resetRouterMock() {
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
}
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useParams: () => routerMock.params,
    useNavigate: () => vi.fn(),
    // BillDetail derives prev/next "pending" from the router's navigation state;
    // under a plain MemoryRouter the real useNavigation has no data-router context,
    // so stub it idle.
    useNavigation: () => ({ state: 'idle' }),
    useLocation: () => routerMock.location,
    useLoaderData: () => routerMock.loaderData,
  }
})

// ── Scroll container (jsdom has no .scrollTo) ─────────────────────────────────
vi.mock('../lib/scrollUtils', () => ({
  getScrollContainer: () => ({ scrollTo: vi.fn() }),
}))

// ── Heavy editor components that break in jsdom ───────────────────────────────
vi.mock('../components/RichTextEditor', () => ({
  RichTextEditor: () => null,
}))

// ── PositionBadge: render tooltip as data-tooltip attr for testability ─────────
vi.mock('../components/PositionBadge', () => ({
  PositionBadge: ({ position, tooltip }: { position: string; tooltip?: string }) => (
    <span data-tooltip={tooltip}>{position}</span>
  ),
}))

// ── Hooks / contexts ──────────────────────────────────────────────────────────
const authState = vi.hoisted(() => ({ role: 'member' as 'member' | 'admin' | 'owner', canVote: false }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, subtitle: null, canVote: authState.canVote },
    loading: false,
  }),
}))

vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoLocked: false }),
}))

vi.mock('../context/SidebarRefreshContext', () => ({
  useSidebarRefresh: () => vi.fn(),
}))

vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({ unreadCount: 0, refresh: vi.fn() }),
}))

vi.mock('../hooks/usePolling', () => ({
  usePolling: () => {},
}))

vi.mock('../hooks/usePageTitle', () => ({
  usePageTitle: () => {},
}))

// ── Minimal bill fixture ──────────────────────────────────────────────────────
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
  myNote: null,
  priorityMeta: null,
  position: { position: 'support', setByName: 'Admin', updatedAt: '2025-01-01 00:00:00' },
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 },
  memberVotes: [],
  comments: [],
  commentsTotal: 0,
}

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}

function makeMockApiFetch(overrides: Record<string, unknown> = {}) {
  // BillDetail now reads the bill from the route loader (useLoaderData), so seed
  // that with the same fixture+overrides the bill fetch used to return.
  routerMock.loaderData = { ...BILL, ...overrides }
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return { ...BILL, ...overrides } as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/notifications/mark-read-by-bill/42') return {} as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

beforeEach(resetRouterMock)

describe('BillDetail org noun labels', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the position section header using orgPositionLabel', async () => {
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Association position')).toBeInTheDocument()
  })

  it('renders the relevance chip label using orgRelevanceLabel', async () => {
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Association relevance')).toBeInTheDocument()
  })

  it('renders the position badge tooltip using orgNoun possessive', async () => {
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    // Wait for bill to load and position section to appear
    await screen.findByText('Association position')
    // PositionBadge is mocked to expose the tooltip prop as data-tooltip
    const badge = document.querySelector('[data-tooltip]')
    expect(badge?.getAttribute('data-tooltip')).toBe("Your association's official position on this bill")
  })
})

describe('BillDetail item dates', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows the recovered date for a document whose structured date is missing', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({
      supplements: [
        {
          supplementId: 1,
          typeId: 2,
          type: 'Analysis',
          date: '0000-00-00',
          dateResolved: '2026-05-21',
          dateInferred: true,
          title: 'Analysis',
          description: 'Statement SSG 5/21/26 SCS SR99',
          mime: 'text/html',
          url: null,
          stateLink: 'https://x',
        },
      ],
    })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    // Wait for bill to load
    await screen.findByText('Test Bill')
    // Open the Documents collapsible section
    const docsButton = screen.getByRole('button', { name: /documents/i })
    await user.click(docsButton)
    // The recovered date should appear in the documents table
    expect(await screen.findByText('2026-05-21')).toBeInTheDocument()
  })
})

describe('BillDetail stuck-state repair affordance', () => {
  beforeEach(() => { vi.restoreAllMocks(); authState.role = 'member' })

  // A tracked bill with text present in R2 but no AI output yet = the dead state.
  const STUCK = { matchType: 'manual' as const, textStatus: 'in_r2' as const, aiProcessedAt: null, aiSkipReason: null, tenantSummary: null }

  it('shows a Run analysis button to admins for a stuck tracked bill', async () => {
    authState.role = 'admin'
    makeMockApiFetch(STUCK)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    expect(await screen.findByRole('button', { name: /run analysis/i })).toBeInTheDocument()
  })

  it('does NOT show the keyword-adjust link for a stuck tracked bill (that is lightweight-only)', async () => {
    authState.role = 'admin'
    makeMockApiFetch(STUCK)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    await screen.findByRole('button', { name: /run analysis/i })
    expect(screen.queryByText(/Adjust keywords/i)).not.toBeInTheDocument()
  })

  it('shows nothing extra to members for a stuck tracked bill (unchanged behavior)', async () => {
    authState.role = 'member'
    makeMockApiFetch(STUCK)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    expect(screen.queryByRole('button', { name: /run analysis|enable full analysis/i })).not.toBeInTheDocument()
  })

  it('still shows Enable full analysis (not Run analysis) for a lightweight stub to admins', async () => {
    authState.role = 'admin'
    makeMockApiFetch({ matchType: null, textStatus: 'available', aiProcessedAt: null, aiSkipReason: null, tenantSummary: null })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    expect(await screen.findByRole('button', { name: /enable full analysis/i })).toBeInTheDocument()
  })
})

describe('BillDetail deferred-nav via /bills/:id (calendar chips, etc.)', () => {
  beforeEach(() => vi.restoreAllMocks())

  // Calendar chips navigate to /bills/:id (no sessionSlug) with prefetchedBill in
  // state. BillDetail must honor the prefetched bill instead of re-fetching (which
  // showed the center spinner on top of the wait cursor).
  it('renders from prefetchedBill without re-fetching the bill, even when arriving via /bills/:id', async () => {
    routerMock.params = { billId: '42' }
    routerMock.location = { state: { prefetchedBill: BILL }, pathname: '/bills/42', hash: '', search: '' }
    const spy = makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Test Bill')).toBeInTheDocument()
    // The prefetched data must be used — no fetch of the bill itself (no spinner).
    expect(spy).not.toHaveBeenCalledWith('/bills/42')
  })
})

describe('BillDetail vote failure rollback', () => {
  beforeEach(() => { vi.restoreAllMocks(); authState.role = 'member'; authState.canVote = true })
  afterEach(() => { authState.canVote = false })

  // Changing an existing vote (support → oppose) and having the request fail must
  // roll the optimistic UI all the way back to the prior vote — not leave the
  // count decremented while the old choice still shows selected (a desync bug).
  it('reverts to the previous vote when changing a vote fails', async () => {
    const user = userEvent.setup()
    // BillDetail seeds from the route loader (useLoaderData), so the starting
    // vote state must be on loaderData, not just the bill fetch.
    routerMock.loaderData = { ...BILL, myVote: 'support', voteCounts: { support: 1, oppose: 0, neutral: 0, total: 1 } }
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/42') return { ...BILL, myVote: 'support', voteCounts: { support: 1, oppose: 0, neutral: 0, total: 1 } } as never
      if (path === '/config') return { ...CONFIG } as never
      if (path === '/config/custom-fields') return [] as never
      if (path === '/notifications/mark-read-by-bill/42') return {} as never
      if (path === '/roles') return [] as never
      if (path === '/users') return [] as never
      if (path === '/bills/42/votes') throw new api.ApiError(500, 'fail')
      return {} as never
    })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const supportRow = screen.getByRole('button', { name: 'Support' }).parentElement!.parentElement!
    const oppic = screen.getByRole('button', { name: 'Oppose' }).parentElement!.parentElement!
    // Baseline: support shows its 1 vote, oppose shows 0.
    expect(within(supportRow).getByText('1')).toBeInTheDocument()
    expect(within(oppic).getByText('0')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Oppose' }))

    // After the failed request settles, the count must be back where it started.
    await waitFor(() => {
      expect(within(supportRow).getByText('1')).toBeInTheDocument()
      expect(within(oppic).getByText('0')).toBeInTheDocument()
    })
  })
})

describe('BillDetail deferred-nav entry (prefetchedBill without billPaths)', () => {
  beforeEach(() => vi.restoreAllMocks())

  // Arriving via useBillNavigate from Feed / sidebar / calendar / notifications:
  // canonical route, router state carries prefetchedBill but NO billPaths/currentIndex.
  // Regression: BillDetail used to read navState.billPaths.length unconditionally,
  // throwing "Cannot read properties of undefined (reading 'length')" → blank page.
  it('renders the prefetched bill and does not crash when billPaths is absent', async () => {
    routerMock.params = { state: 'RI', sessionSlug: '2025-2026', billNumber: 'HB1' }
    routerMock.location = { state: { prefetchedBill: BILL }, pathname: '/RI/2025-2026/HB1', hash: '', search: '' }
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Test Bill')).toBeInTheDocument()
    expect(screen.getByText('Association position')).toBeInTheDocument()
  })
})
