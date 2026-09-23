import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// Mirrors BillDetail.draftState.test.tsx's harness. The bill-number editor
// also rewrites the page's own canonical URL on save (the number is part of
// /STATE/YEAR/NUMBER), so it needs the same stable useNavigate spy.
const navigateMock = vi.hoisted(() => vi.fn())
const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' },
  loaderData: null as unknown,
}))
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
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'admin', subtitle: null, canVote: true },
    loading: false,
  }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }),
}))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({ unreadCount: 0, mentions: [], refresh: vi.fn(async () => {}) }),
}))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

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

/** @param onPatch what PATCH /bills/42/draft does — resolve with the updated
 *  row, or throw an ApiError. */
function mockApi(onPatch?: () => Promise<unknown>) {
  routerMock.loaderData = { ...DRAFT }
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/42' || path.startsWith('/bills/resolve/')) return { ...DRAFT } as never
    if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D2', year: 2026, tenantState: 'RI' } as never
    if (path === '/bills/42/draft' && init?.method === 'PATCH') {
      if (onPatch) return (await onPatch()) as never
      return { ...DRAFT, billNumber: 'D9' } as never
    }
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  navigateMock.mockClear()
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
})
afterEach(() => vi.restoreAllMocks())

describe('BillDetail draft bill-number editor', () => {
  it('prefills the input with the bill\'s current number when opened', async () => {
    const user = userEvent.setup()
    mockApi()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit bill number' }))
    const input = document.querySelector('input[name="draftBillNumber"]') as HTMLInputElement
    expect(input.value).toBe('D1')
  })

  it('saving PATCHes the new bill number and updates the display', async () => {
    const user = userEvent.setup()
    mockApi()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    const trigger = await screen.findByRole('button', { name: 'Edit bill number' })
    expect(trigger).toHaveTextContent('Bill number: D1')
    await user.click(trigger)

    const input = document.querySelector('input[name="draftBillNumber"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'D9')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ billNumber: 'D9' }) }),
    ))
    expect(await screen.findByRole('button', { name: 'Edit bill number' })).toHaveTextContent('Bill number: D9')
  })

  it('surfaces a 409 from the server inline', async () => {
    const user = userEvent.setup()
    mockApi(async () => { throw new api.ApiError(409, 'D9 is already used by another RI bill in 2026.') })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit bill number' }))
    const input = document.querySelector('input[name="draftBillNumber"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'D9')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('D9 is already used by another RI bill in 2026.')).toBeInTheDocument()
  })

  it('rewrites the canonical URL so it cannot name the old bill number', async () => {
    const user = userEvent.setup()
    mockApi()
    routerMock.params = { state: 'RI', sessionSlug: '2026', billNumber: 'D1' }
    routerMock.location = { state: null, pathname: '/RI/2026/D1', hash: '', search: '' }
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit bill number' }))
    const input = document.querySelector('input[name="draftBillNumber"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'D9')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/RI/2026/D9', { replace: true }))
  })

  it('leaves the URL alone on the uuid route, which carries no bill number', async () => {
    const user = userEvent.setup()
    mockApi()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit bill number' }))
    const input = document.querySelector('input[name="draftBillNumber"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'D9')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('button', { name: 'Edit bill number' })).toHaveTextContent('Bill number: D9')
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
