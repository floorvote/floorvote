import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// #806: a bill's Bill texts and Actions panels fold back up when their title is clicked.

const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' } as {
    state: unknown; pathname: string; hash: string; search: string
  },
  loaderData: null as unknown,
}))
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
vi.mock('../lib/scrollUtils', () => ({ getScrollContainer: () => ({ scrollTo: vi.fn(), scrollTop: 0 }) }))
vi.mock('../components/RichTextEditor', () => ({ RichTextEditor: () => null }))
vi.mock('../components/PositionBadge', () => ({ PositionBadge: ({ position }: { position: string }) => <span>{position}</span> }))
vi.mock('../context/DemoContext', () => ({ useDemo: () => ({ demoLocked: false }) }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'member', canVote: true }, loading: false }),
}))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({ useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn() }) }))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

// ── Fixtures ────────────────────────────────────────────────────────────────

const T1 = { docId: '9001', type: 'Introduced', date: '2026-01-13', mime: 'text/html', stateLink: null, altStateLink: null }

const PAGE = {
  id: '42', externalId: 'legiscan:100', billNumber: 'A100', title: 'Drop Boxes', state: 'RI', status: 'Introduced',
  statusDate: null, session: '2025-2026', sessionId: '1', sessionSlug: '2025-2026', yearStart: 2025, yearEnd: 2026,
  description: null, billType: null, body: null, currentBody: null, abstract: null, stateLink: null, stateUrl: null,
  url: null, legiscanUrl: null, committee: null, referrals: [],
  tenantSummary: null, tags: [], relevanceScore: 7, priority: null, textR2Key: 'bills/100.html',
  sponsor: null, sponsorParty: null, sponsorUrl: null, coSponsors: [], lastAction: 'Referred to committee', lastActionDate: '2026-01-14',
  history: [{ date: '2026-01-14', action: 'Referred to committee', chamber: 'H' }], voteSummary: [], subjects: [], relatedBillIds: [], companionBillIds: [],
  texts: [T1], calendar: [], supplements: [], amendments: [], customFieldValues: {},
  matchType: 'keyword' as const, isDraft: false, draftText: null,
  createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00', centralSyncedAt: null,
  aiProcessedAt: null, aiSkipReason: null, lastAiTextDocId: null, textStatus: 'in_r2' as const, myVote: null, myNote: null, priorityMeta: null, position: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 }, memberVotes: [], comments: [], commentsTotal: 0,
  groupBills: [], groupTexts: [],
}

const CONFIG = { associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'], states: ['RI'], instanceDomains: {}, orgNoun: 'association' }

function setup() {
  routerMock.params = { billId: '42' }
  routerMock.loaderData = PAGE
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path.startsWith('/bills/')) return PAGE as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles' || path === '/users') return [] as never
    return {} as never
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html><body><p>text</p></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

describe.each(['Bill texts', 'Actions'])('%s panel on a bill page', (label) => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('folds back up when its title is clicked', async () => {
    const user = userEvent.setup()
    setup()
    const button = await screen.findByRole('button', { name: new RegExp('^' + label) })
    await user.click(screen.getByText(label))
    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'true'))
    // Let the open animation settle, as it does in a browser.
    await new Promise(r => setTimeout(r, 300))

    await user.click(screen.getByText(label))

    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'))
  })
})
