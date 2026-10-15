import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// Untitled drafts on the bill page: the heading reads "Untitled draft", the
// title editor opens empty (never pre-filled with the label), and a blank save
// clears the title. Harness mirrors BillDetail.draftBillNumber.test.tsx.
const navigateMock = vi.hoisted(() => vi.fn())
const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' },
  loaderData: null as unknown,
}))
const authMock = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'member' }))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useParams: () => routerMock.params,
    useNavigate: () => navigateMock,
    useNavigation: () => ({ state: 'idle' }),
    useLocation: () => routerMock.location,
    useLoaderData: () => routerMock.loaderData,
  }
})

vi.mock('../lib/scrollUtils', () => ({ getScrollContainer: () => ({ scrollTo: vi.fn() }) }))
vi.mock('../components/RichTextEditor', () => ({ RichTextEditor: () => null }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authMock.role, title: null, canVote: true },
    loading: false,
  }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }),
}))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn(async () => {}) }),
}))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
const pageTitle = vi.hoisted(() => ({ last: null as string | null }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: (t: string | null) => { pageTitle.last = t } }))

const DRAFT = {
  id: '42',
  externalId: null,
  billNumber: 'D1',
  title: 'Pre-filed draft',
  state: 'RI',
  status: '',
  statusDate: null,
  session: '',
  sessionId: null,
  sessionSlug: '2026',
  yearStart: 2026,
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
  matchType: 'manual' as const,
  isDraft: true,
  draftText: null,
  createdAt: '2026-01-01 00:00:00',
  updatedAt: '2026-01-01 00:00:00',
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
}

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}

type BillOverrides = Partial<Record<keyof typeof DRAFT, unknown>>

/** @param bill overrides on the draft fixture. PATCH echoes the sent title. */
function mockApi(bill: BillOverrides = {}) {
  const row = { ...DRAFT, ...bill }
  routerMock.loaderData = { ...row }
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/42' || path.startsWith('/bills/resolve/')) return { ...row } as never
    if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D2', year: 2026, tenantState: 'RI' } as never
    if (path === '/bills/42/draft' && init?.method === 'PATCH') {
      const sent = JSON.parse(String(init.body)) as { title?: string }
      return { ...row, ...sent } as never
    }
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/calendar/bill-options') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

function titleInput(): HTMLInputElement {
  return document.querySelector('input[name="draftTitle"]') as HTMLInputElement
}

beforeEach(() => {
  vi.restoreAllMocks()
  navigateMock.mockClear()
  authMock.role = 'admin'
  pageTitle.last = null
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
})
afterEach(() => vi.restoreAllMocks())

describe('BillDetail untitled draft heading', () => {
  it('shows "Untitled draft" as the heading of a draft with no title', async () => {
    mockApi({ title: '' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    const heading = await screen.findByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent('Untitled draft')
  })

  it('shows "Untitled draft" to a non-admin too', async () => {
    authMock.role = 'member'
    mockApi({ title: '' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    const heading = await screen.findByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent('Untitled draft')
    expect(screen.queryByRole('button', { name: 'Edit title' })).toBeNull()
  })

  it('keeps the bill number visible beside an untitled draft', async () => {
    mockApi({ title: '' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByRole('button', { name: 'Edit bill number' })).toHaveTextContent('D1')
  })

  it('uses "Untitled draft" in the browser tab title', async () => {
    mockApi({ title: '' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByRole('heading', { level: 1 })
    expect(pageTitle.last).toBe('RI D1 — Untitled draft')
  })

  it("shows a titled draft's own title", async () => {
    mockApi({ title: 'Draft bill title' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    const heading = await screen.findByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent('Draft bill title')
    expect(heading).not.toHaveTextContent('Untitled draft')
  })

  it('never labels a filed bill "Untitled draft" — a blank filed title falls back to the abstract', async () => {
    authMock.role = 'member'
    mockApi({ title: '', isDraft: false, externalId: 'legiscan:1', matchType: 'keyword', abstract: 'Filed bill abstract' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    const heading = await screen.findByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent('Filed bill abstract')
    expect(screen.queryByText('Untitled draft')).toBeNull()
  })
})

describe('BillDetail draft title editor', () => {
  it('opens empty for an untitled draft, not pre-filled with the label', async () => {
    const user = userEvent.setup()
    mockApi({ title: '' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Edit title' }))
    expect(titleInput().value).toBe('')
  })

  it('saving a blank value clears the title and shows "Untitled draft"', async () => {
    const user = userEvent.setup()
    mockApi({ title: 'Placeholder title' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit title' }))
    expect(titleInput().value).toBe('Placeholder title')
    await user.clear(titleInput())
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: '' }) }),
    ))
    expect(await screen.findByRole('button', { name: 'Edit title' })).toHaveTextContent('Untitled draft')
    expect(titleInput()).toBeNull()
  })

  it('saving whitespace only clears the title', async () => {
    const user = userEvent.setup()
    mockApi({ title: 'Placeholder title' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit title' }))
    await user.clear(titleInput())
    await user.type(titleInput(), '   ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: '' }) }),
    ))
    expect(await screen.findByRole('button', { name: 'Edit title' })).toHaveTextContent('Untitled draft')
  })

  it('adds a title to an untitled draft', async () => {
    const user = userEvent.setup()
    mockApi({ title: '' })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit title' }))
    await user.type(titleInput(), 'Draft bill title')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Draft bill title' }) }),
    ))
    const trigger = await screen.findByRole('button', { name: 'Edit title' })
    expect(trigger).toHaveTextContent('Draft bill title')
    expect(trigger).not.toHaveTextContent('Untitled draft')
  })

  it('keeps the editor open and the old title when the save fails', async () => {
    const user = userEvent.setup()
    const spy = mockApi({ title: 'Placeholder title' })
    const impl = spy.getMockImplementation()!
    spy.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/bills/42/draft' && init?.method === 'PATCH') throw new api.ApiError(500, 'Save failed.')
      return impl(path, init)
    })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit title' }))
    await user.clear(titleInput())
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Save failed.')).toBeInTheDocument()
    expect(titleInput()).not.toBeNull()
  })
})
