import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// ── Scaffolding copied from BillDetail.statusExplainer.test.tsx ───────────────

const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' } as {
    state: unknown; pathname: string; hash: string; search: string
  },
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
    useNavigation: () => ({ state: 'idle' }),
    useLocation: () => routerMock.location,
    useLoaderData: () => routerMock.loaderData,
  }
})

vi.mock('../lib/scrollUtils', () => ({
  getScrollContainer: () => ({ scrollTo: vi.fn() }),
}))

// Unlike BillDetail.test.tsx (which mocks this to null), this task's controls
// live partly inside RichTextEditor (the comment composer's "Post", the
// edit-comment "Save"), so the mock needs to actually render a button and
// forward the `disabled` prop for the demo-lock assertions to see.
vi.mock('../components/RichTextEditor', () => ({
  RichTextEditor: ({ submitLabel = 'Post', onSubmit, disabled }: { submitLabel?: string; onSubmit?: (html: string) => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onSubmit?.('<p>hi</p>')}>{submitLabel}</button>
  ),
}))

vi.mock('../components/PositionBadge', () => ({
  PositionBadge: ({ position }: { position: string }) => <span>{position}</span>,
}))

const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoLocked: demoState.demoLocked }),
}))

const authState = vi.hoisted(() => ({ role: 'admin' as 'member' | 'admin' | 'owner', canVote: true }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, subtitle: null, canVote: authState.canVote },
    loading: false,
  }),
}))

vi.mock('../context/SidebarRefreshContext', () => ({
  useSidebarRefresh: () => vi.fn(),
}))

vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn() }),
}))

vi.mock('../hooks/usePolling', () => ({
  usePolling: () => {},
}))

vi.mock('../hooks/usePageTitle', () => ({
  usePageTitle: () => {},
}))

// ── Fixtures ────────────────────────────────────────────────────────────────

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

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}



function renderBillDetail(overrides: Record<string, unknown>) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})

const route = (id: string, billNumber: string) => ({ id, billNumber, sessionSlug: '2026', state: 'NJ' })

const RELATED = [
  { billId: 102, billNumber: 'S1713', type: 'same-as', kind: 'identical', route: route('b102', 'S1713') },
  { billId: 103, billNumber: 'S1714', type: 'same-as', kind: 'identical', route: null },
  { billId: 104, billNumber: 'HB4002', type: 'same-as', kind: 'package', route: null },
  { billId: 105, billNumber: 'A77', type: 'similar-to', kind: 'related', route: null },
  { billId: 106, billNumber: 'A78', type: 'carry-over', kind: 'related', route: null },
]

describe('the related bills on a bill page', () => {
  it('shows identical, package, and related bills under their own labels', async () => {
    renderBillDetail({ state: 'NJ', relatedBillIds: RELATED })
    const identical = await screen.findByText('Identical to:')
    const pkg = screen.getByText('Part of a package:')
    const related = screen.getByText('Related:')
    expect(identical.parentElement).toHaveTextContent('S1713')
    expect(identical.parentElement).toHaveTextContent('S1714')
    expect(identical.parentElement).not.toHaveTextContent('HB4002')
    expect(pkg.parentElement).toHaveTextContent('HB4002')
    expect(pkg.parentElement).not.toHaveTextContent('S1713')
    // Two raw labels (Similar To, Carry Over) share the one related line.
    expect(related.parentElement).toHaveTextContent('A77')
    expect(related.parentElement).toHaveTextContent('A78')
    // A bill the instance tracks links to its page, and the rest are plain numbers.
    expect(screen.getByRole('link', { name: 'S1713' })).toHaveAttribute('href', expect.stringContaining('/NJ/2026/'))
    expect(screen.queryByRole('link', { name: 'S1714' })).toBeNull()
  })

  it('shows a label only when the bill has a relationship of that kind', async () => {
    renderBillDetail({ state: 'NJ', relatedBillIds: [RELATED[0]] })
    await screen.findByText('Identical to:')
    expect(screen.queryByText('Part of a package:')).toBeNull()
    expect(screen.queryByText('Related:')).toBeNull()
  })

  it('shows a relationship with no kind, from an older central, as related', async () => {
    renderBillDetail({ state: 'NJ', relatedBillIds: [{ billId: 0, billNumber: 'S2', type: 'same-as', route: null }] })
    const related = await screen.findByText('Related:')
    expect(related.parentElement).toHaveTextContent('S2')
    expect(screen.queryByText('Identical to:')).toBeNull()
  })
})

describe('the identical bills on the page of a grouped bill', () => {
  const inGroup = (...ids: Array<[string, string]>) => [
    { billId: '42', billNumber: 'HB 1', state: 'NJ', sessionSlug: '2026' },
    ...ids.map(([billId, billNumber]) => ({ billId, billNumber, state: 'NJ', sessionSlug: '2026' })),
  ]

  it('lists only the identical bills outside the group', async () => {
    renderBillDetail({ state: 'NJ', relatedBillIds: RELATED, groupBills: inGroup(['b102', 'S1713']) })
    const identical = await screen.findByText('Identical to:')
    expect(identical.parentElement).toHaveTextContent('S1714')
    expect(identical.parentElement).not.toHaveTextContent('S1713')
  })

  it('lists only the bill outside the group when identical relationships name one in the group and one an admin split off', async () => {
    const splitOff = { billId: 107, billNumber: 'S1720', type: 'same-as', kind: 'identical', route: route('b107', 'S1720') }
    renderBillDetail({ state: 'NJ', relatedBillIds: [RELATED[0], splitOff], groupBills: inGroup(['b102', 'S1713']) })
    const identical = await screen.findByText('Identical to:')
    expect(identical.parentElement).toHaveTextContent('S1720')
    expect(identical.parentElement).not.toHaveTextContent('S1713')
    expect(within(identical.parentElement!).getByRole('link', { name: 'S1720' })).toHaveAttribute('href', expect.stringContaining('/NJ/2026/'))
  })

  it('renders no "Identical to:" entry when every identical bill is in the group, and leaves package and related entries alone', async () => {
    renderBillDetail({ state: 'NJ', relatedBillIds: [RELATED[0], RELATED[2], RELATED[3], RELATED[4]], groupBills: inGroup(['b102', 'S1713']) })
    const pkg = await screen.findByText('Part of a package:')
    expect(screen.queryByText('Identical to:')).toBeNull()
    expect(pkg.parentElement).toHaveTextContent('HB4002')
    expect(screen.getByText('Related:').parentElement).toHaveTextContent('A77')
    expect(screen.getByText('Related:').parentElement).toHaveTextContent('A78')
  })

  it('does not drop a package bill that is also in the group', async () => {
    const pkgInGroup = { billId: 108, billNumber: 'S1730', type: 'same-as', kind: 'package', route: route('b108', 'S1730') }
    renderBillDetail({ state: 'NJ', relatedBillIds: [pkgInGroup], groupBills: inGroup(['b108', 'S1730']) })
    expect((await screen.findByText('Part of a package:')).parentElement).toHaveTextContent('S1730')
  })

  it('keeps every identical bill for a bill in no group', async () => {
    renderBillDetail({ state: 'NJ', relatedBillIds: RELATED, groupBills: [{ billId: '42', billNumber: 'HB 1', state: 'NJ', sessionSlug: '2026' }] })
    const identical = await screen.findByText('Identical to:')
    expect(identical.parentElement).toHaveTextContent('S1713')
    expect(identical.parentElement).toHaveTextContent('S1714')
  })
})
