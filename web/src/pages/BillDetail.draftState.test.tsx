import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// The draft State editor lives in the same admin row as the bill-number and
// year editors, but it is the only one of the three that (a) is gated on a
// server signal and (b) changes the page's own canonical URL — so it gets its
// own harness, with a stable useNavigate spy the shared BillDetail.test.tsx
// mock (a fresh vi.fn() per call) cannot provide.
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

/** @param tenantState what GET /bills/draft-defaults reports: a postal code on
 *  a single-state tenant, null on a multi-state one.
 *  @param onPatch what PATCH /bills/42/draft does — resolve with the updated
 *  row, or throw an ApiError.
 *  @param facetStates what GET /bills/facets reports for `state` — the option
 *  list for the State Picker (see DraftBills.tsx's `knownStates`). Omitted
 *  (undefined) mocks a facets failure, which falls back to free text. */
function mockApi(tenantState: string | null, onPatch?: () => Promise<unknown>, facetStates?: Record<string, number>) {
  routerMock.loaderData = { ...DRAFT }
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/42' || path.startsWith('/bills/resolve/')) return { ...DRAFT } as never
    if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D2', year: 2026, tenantState } as never
    if (path === '/bills/facets') {
      if (facetStates) return { state: facetStates } as never
      throw new api.ApiError(500, 'facets unavailable')
    }
    if (path === '/bills/42/draft' && init?.method === 'PATCH') {
      if (onPatch) return (await onPatch()) as never
      return { ...DRAFT, state: 'TX' } as never
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

describe('BillDetail draft State editor', () => {
  it('is not offered when draft-defaults reports a configured tenant state', async () => {
    mockApi('RI')
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    // The sibling editors are the proof the row itself rendered, so an absent
    // State button means "gated off", not "nothing drew yet".
    await screen.findByRole('button', { name: 'Edit bill number' })
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/bills/draft-defaults')))
    expect(screen.queryByRole('button', { name: 'Edit state' })).not.toBeInTheDocument()
  })

  it('passes the draft\'s own state to draft-defaults', async () => {
    mockApi(null)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByRole('button', { name: 'Edit state' })
    expect(api.apiFetch).toHaveBeenCalledWith('/bills/draft-defaults?state=RI')
  })

  it('is offered on a multi-state tenant, and saving PATCHes the new state', async () => {
    const user = userEvent.setup()
    mockApi(null)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    const trigger = await screen.findByRole('button', { name: 'Edit state' })
    expect(trigger).toHaveTextContent('State: RI')
    await user.click(trigger)

    const input = document.querySelector('input[name="draftState"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'tx')
    expect(input.value).toBe('TX') // uppercased as typed
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ state: 'TX' }) }),
    ))
    expect(await screen.findByRole('button', { name: 'Edit state' })).toHaveTextContent('State: TX')
  })

  it('surfaces a 409 from the server inline', async () => {
    const user = userEvent.setup()
    mockApi(null, async () => { throw new api.ApiError(409, 'D1 is already used by another TX bill in 2026.') })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit state' }))
    const input = document.querySelector('input[name="draftState"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'TX')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('D1 is already used by another TX bill in 2026.')).toBeInTheDocument()
  })

  it('rewrites the canonical URL so it cannot name the old state', async () => {
    const user = userEvent.setup()
    mockApi(null)
    routerMock.params = { state: 'RI', sessionSlug: '2026', billNumber: 'D1' }
    routerMock.location = { state: null, pathname: '/RI/2026/D1', hash: '', search: '' }
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit state' }))
    const input = document.querySelector('input[name="draftState"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'TX')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/TX/2026/D1', { replace: true }))
  })

  it('leaves the URL alone on the uuid route, which carries no state', async () => {
    const user = userEvent.setup()
    mockApi(null)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit state' }))
    const input = document.querySelector('input[name="draftState"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'TX')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('button', { name: 'Edit state' })).toHaveTextContent('State: TX')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  // When facets has something to offer, the State editor is the same Picker
  // single-select as the create form (DraftBills.tsx), not free text.
  it('offers a Picker (not free text) when facets reports known states, and saves the chosen one', async () => {
    const user = userEvent.setup()
    mockApi(null, undefined, { RI: 3, TX: 2 })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit state' }))
    expect(document.querySelector('input[name="draftState"]')).toBeNull()
    const stateTrigger = await screen.findByRole('button', { name: 'State' })
    expect(stateTrigger).toHaveTextContent('RI')
    await user.click(stateTrigger)
    fireEvent.click(screen.getByRole('radio', { name: 'TX' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ state: 'TX' }) }),
    ))
    expect(await screen.findByRole('button', { name: 'Edit state' })).toHaveTextContent('State: TX')
  })

  // The Picker is controlled, unlike the free-text fallback's plain <input> —
  // it must be seeded with the bill's current state when the editor opens.
  it('prefills the State picker with the bill\'s current state when opened', async () => {
    const user = userEvent.setup()
    mockApi(null, undefined, { RI: 3, TX: 2 })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await user.click(await screen.findByRole('button', { name: 'Edit state' }))
    const stateTrigger = await screen.findByRole('button', { name: 'State' })
    await user.click(stateTrigger)
    expect(screen.getByRole('radio', { name: 'RI' })).toBeChecked()
  })
})
