import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// ── Scaffolding copied from BillDetail.readOnly.test.tsx ──────────────────────

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
  useNotifications: () => ({ unreadCount: 0, mentions: [], refresh: vi.fn() }),
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


const EXPLAINER = 'Passed by the Council and sent to the Mayor, who has 10 working days to sign or veto it.'
const DC_LABELS = {
  state: 'DC',
  statuses: [{ label: 'Under Mayoral Review', stage: 'passed', rank: 401, explainer: EXPLAINER }],
  billTypes: [], eventTypes: [], calendarName: 'DC Council calendar', hasEvents: false,
}

const VA_LABELS = {
  ...DC_LABELS, state: 'VA', calendarName: null,
  statuses: [{ label: 'Introduced', stage: 'introduced', rank: 101, explainer: 'Introduced and sent to a committee.' }],
}

function renderBillDetail(overrides: Record<string, unknown>) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  const spy = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/bills/labels?state=DC') return DC_LABELS as never
    if (path === '/bills/labels?state=VA') return VA_LABELS as never
    if (path === '/config/custom-fields') return [] as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  return spy
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})

describe('the status chip on a bill page', () => {
  it('explains the status on hover, from the state\'s labels', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0400', status: 'Under Mayoral Review' })
    await waitFor(() => {
      fireEvent.pointerEnter(screen.getByText('Under Mayoral Review'), { pointerType: 'mouse' })
      expect(screen.getByText(EXPLAINER)).toBeInTheDocument()
    })
  })

  it('shows no explainer for a status the state\'s labels don\'t list', async () => {
    // Another state, since each state's labels are fetched once per page load.
    const spy = renderBillDetail({ state: 'VA', billNumber: 'HB 1', status: 'Something new' })
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/bills/labels?state=VA'))
    fireEvent.pointerEnter(screen.getByText('Something new'), { pointerType: 'mouse' })
    expect(screen.queryByText(EXPLAINER)).toBeNull()
    expect(screen.queryByText('Introduced and sent to a committee.')).toBeNull()
  })

  it('asks for no labels for a draft, which has no status', async () => {
    const spy = renderBillDetail({ state: 'DC', billNumber: 'D1', status: '', isDraft: true })
    await screen.findByText('Test Bill')
    expect(spy).not.toHaveBeenCalledWith(expect.stringMatching(/^\/bills\/labels/))
  })
})
