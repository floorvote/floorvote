import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// The session chip on a bill page links to the Bills page's year filter. The
// Bills page reads no session param, so a bill without a usable yearStart gets
// a plain, non-clickable chip instead of a link to a filter that does not exist.

// ── Scaffolding copied from BillDetail.billNav.test.tsx ───────────────

const routerMock = vi.hoisted(() => ({
  navigate: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  navigationState: 'idle' as 'idle' | 'loading',
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' } as {
    state: unknown; pathname: string; hash: string; search: string
  },
  loaderData: null as unknown,
}))
function resetRouterMock() {
  routerMock.navigate = vi.fn()
  routerMock.navigationState = 'idle'
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
}
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useParams: () => routerMock.params,
    useNavigate: () => routerMock.navigate,
    useNavigation: () => ({ state: routerMock.navigationState }),
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
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, title: null, canVote: authState.canVote },
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

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}




async function renderBill(overrides: Record<string, unknown>) {
  const bill = { ...BILL, ...overrides }
  routerMock.params = { state: 'RI', sessionSlug: '2025-2026', billNumber: 'HB2' }
  routerMock.location = { state: null, pathname: '/RI/2025-2026/HB2', hash: '', search: '' }
  routerMock.loaderData = bill
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path.startsWith('/bills/labels')) return { state: 'RI', statuses: [], billTypes: [], eventTypes: [], calendarName: null, hasEvents: false } as never
    if (path.startsWith('/bills/')) return bill as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  await screen.findByText('Test Bill')
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})

describe('bill page session chip', () => {
  it('is a button that opens the year filter when the bill has a yearStart', async () => {
    await renderBill({ session: '2025 Regular Session', yearStart: 2025 })
    fireEvent.click(screen.getByRole('button', { name: '2025 Regular Session' }))
    expect(routerMock.navigate).toHaveBeenCalledTimes(1)
    expect(routerMock.navigate).toHaveBeenCalledWith('/bills?year=2025&state=RI')
  })

  it('omits the state param when the bill has no state', async () => {
    await renderBill({ session: '2025 Regular Session', yearStart: 2025, state: '' })
    fireEvent.click(screen.getByRole('button', { name: '2025 Regular Session' }))
    expect(routerMock.navigate).toHaveBeenCalledWith('/bills?year=2025')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['0', 0],
  ])('renders plain text, with no button, when yearStart is %s', async (_label, yearStart) => {
    await renderBill({ session: 'Regular Session', yearStart })
    expect(screen.getByText('Regular Session')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Regular Session' })).toBeNull()
    expect(screen.getByText('Regular Session').closest('button')).toBeNull()
  })

  it.each([null, 0])('navigates nowhere when the plain chip is clicked (yearStart %s)', async (yearStart) => {
    await renderBill({ session: 'Regular Session', yearStart })
    fireEvent.click(screen.getByText('Regular Session'))
    expect(routerMock.navigate).not.toHaveBeenCalled()
  })

  it('never navigates to a session query param', async () => {
    await renderBill({ session: 'Regular Session', yearStart: null })
    fireEvent.click(screen.getByText('Regular Session'))
    fireEvent.keyDown(screen.getByText('Regular Session'), { key: 'Enter' })
    const urls = routerMock.navigate.mock.calls.map(c => String(c[0]))
    expect(urls.filter(u => u.includes('session='))).toEqual([])
  })

  it('renders no chip for an empty session', async () => {
    await renderBill({ session: '', yearStart: 2025 })
    expect(screen.queryByRole('button', { name: /session|2025/i })).toBeNull()
    expect(screen.queryByText('2025-2026')).toBeNull()
  })
})
