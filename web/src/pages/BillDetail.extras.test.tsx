import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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



const EXTRAS = {
  providerName: 'DC Council LIMS',
  fields: [
    { key: 'lawNumber', label: 'D.C. Law number', explainer: 'The number the act took when it became law.', display: 'identifier', value: 'L26-0042' },
    { key: 'effectiveDate', label: 'Effective date', explainer: null, display: 'date', value: '2026-06-01' },
    { key: 'packet', label: 'Introduction packet', explainer: null, display: 'link', value: 'https://lims.dccouncil.gov/downloads/B26-0001.pdf' },
    { key: 'withdrawnBy', label: 'Withdrawn by', explainer: null, display: 'text', value: 'Councilmember Example' },
  ],
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

describe('the provider extras panel on a bill page', () => {
  it('shows each extra under the provider\'s name, by its display type', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0001', extras: EXTRAS })
    const toggle = await screen.findByRole('button', { name: /Additional information from DC Council LIMS/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    expect(screen.getByText('D.C. Law number')).toBeInTheDocument()
    expect(screen.getByText('L26-0042')).toBeInTheDocument()
    expect(screen.getByText('2026-06-01')).toBeInTheDocument()
    expect(screen.getByText('Councilmember Example')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /lims\.dccouncil\.gov/ })
    expect(link).toHaveAttribute('href', 'https://lims.dccouncil.gov/downloads/B26-0001.pdf')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('explains an extra in a tooltip', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0001', extras: EXTRAS })
    fireEvent.click(await screen.findByRole('button', { name: /Additional information from/ }))
    fireEvent.click(screen.getByRole('button', { name: 'About D.C. Law number' }))
    await waitFor(() => expect(screen.getByText('The number the act took when it became law.')).toBeInTheDocument())
  })

  it('never turns a link that isn\'t http(s) into an href', async () => {
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001',
      extras: { providerName: 'DC Council LIMS', fields: [{ key: 'packet', label: 'Packet', explainer: null, display: 'link', value: 'javascript:alert(1)' }] },
    })
    await screen.findByRole('button', { name: /Additional information from/ })
    expect(screen.getByText('javascript:alert(1)').closest('a')).toBeNull()
  })

  it('keeps the line breaks of a multi-paragraph text value', async () => {
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001',
      extras: { providerName: 'DC Council LIMS', fields: [{ key: 'note', label: 'Note', explainer: null, display: 'text', value: 'First paragraph.\nSecond paragraph.' }] },
    })
    await screen.findByRole('button', { name: /Additional information from/ })
    expect(screen.getByText(/First paragraph\./)).toHaveStyle({ whiteSpace: 'pre-line' })
  })

  it('isn\'t there when the bill has no extras', async () => {
    renderBillDetail({ extras: null })
    await screen.findByText('Test Bill')
    expect(screen.queryByText(/Additional information from/)).toBeNull()
  })
})
