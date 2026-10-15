import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// Grouping and splitting bills by hand from the bill page's overflow menu
// (#382): an admin gets "Group with…" (a bill picker) and, on a grouped bill,
// "Split from group". A standard member gets neither.

// ── Scaffolding copied from BillDetail.companionGroup.test.tsx ────────────────

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

vi.mock('../components/RichTextEditor', () => ({
  RichTextEditor: ({ submitLabel = 'Post', onSubmit, disabled }: { submitLabel?: string; onSubmit?: (html: string) => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onSubmit?.('<p>hi</p>')}>{submitLabel}</button>
  ),
}))

vi.mock('../components/PositionBadge', () => ({
  PositionBadge: ({ position }: { position: string }) => <span>{position}</span>,
}))

vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoLocked: false }),
}))

const authState = vi.hoisted(() => ({ role: 'admin' as 'member' | 'admin' | 'owner' }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, subtitle: null, canVote: true },
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
  billNumber: 'A190',
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
  tenantSummary: null,
  tags: [],
  relevanceScore: null,
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
  position: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 },
  memberVotes: [],
  comments: [],
  commentsTotal: 0,
  groupBills: [{ billId: '42', billNumber: 'A190' }],
}

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}

// The bills the picker offers: this bill, its companion, a draft, and two others.
const BILL_OPTIONS = [
  { id: '42', billNumber: 'A190', title: 'Test Bill', state: 'RI', isDraft: false },
  { id: 'b1713', billNumber: 'S1713', title: 'Companion', state: 'RI', isDraft: false },
  { id: 'draft-1', billNumber: 'S1799', title: 'A draft', state: 'RI', isDraft: true },
  { id: 'c1714', billNumber: 'S1714', title: 'Another bill', state: 'RI', isDraft: false },
  { id: 'd1715', billNumber: 'S1715', title: 'Yet another', state: 'RI', isDraft: false },
]

const GROUPED = { groupBills: [{ billId: '42', billNumber: 'A190' }, { billId: 'b1713', billNumber: 'S1713' }] }

function renderBillDetail(overrides: Record<string, unknown> = {}) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  const apiFetch = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles' || path === '/users') return [] as never
    if (path === '/calendar/bill-options') return BILL_OPTIONS as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  return apiFetch
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await screen.findAllByText('A190')
  await user.click(screen.getByRole('button', { name: 'More actions' }))
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
  authState.role = 'admin'
})

afterEach(() => { authState.role = 'admin' })

describe('grouping and splitting from the overflow menu', () => {
  it('offers an admin "Group with…" and, on a grouped bill, "Split from group"', async () => {
    const user = userEvent.setup()
    renderBillDetail(GROUPED)
    await openMenu(user)
    expect(screen.getByRole('menuitem', { name: /Group with…/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Split from group/ })).toBeInTheDocument()
  })

  it('offers no "Split from group" on a bill in no group', async () => {
    const user = userEvent.setup()
    renderBillDetail()
    await openMenu(user)
    expect(screen.getByRole('menuitem', { name: /Group with…/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Split from group/ })).toBeNull()
  })

  it('offers a standard member neither', async () => {
    const user = userEvent.setup()
    authState.role = 'member'
    renderBillDetail(GROUPED)
    await openMenu(user)
    expect(screen.queryByRole('menuitem', { name: /Group with…/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Split from group/ })).toBeNull()
  })

  it('groups the bill with the bill picked, from bills not already in its group', async () => {
    const user = userEvent.setup()
    const apiFetch = renderBillDetail(GROUPED)
    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: /Group with…/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Group A190 with another bill' })

    // Neither this bill, its companion, nor a draft can be picked.
    await user.type(within(dialog).getByPlaceholderText('Search bills…'), 'S17')
    const offered = within(dialog).getAllByRole('button').map(b => b.textContent ?? '').filter(t => t.startsWith('S17'))
    expect(offered).toEqual([expect.stringContaining('S1714'), expect.stringContaining('S1715')])

    await user.click(within(dialog).getByRole('button', { name: /S1714/ }))
    const reads = () => apiFetch.mock.calls.filter(([p]) => p === '/bills/42').length
    const readsBefore = reads()
    await user.click(within(dialog).getByRole('button', { name: 'Group bills' }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/group', {
      method: 'POST',
      body: JSON.stringify({ withBillId: 'c1714' }),
    }))
    // The page reads the bill again, for its new group and grouping line.
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('splits the bill from its group once confirmed', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const apiFetch = renderBillDetail(GROUPED)
    await openMenu(user)
    const reads = () => apiFetch.mock.calls.filter(([p]) => p === '/bills/42').length
    const readsBefore = reads()
    await user.click(screen.getByRole('menuitem', { name: /Split from group/ }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('S1713'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/split', { method: 'POST' }))
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore))
  })
})
