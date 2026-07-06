import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// ── Router mock (mutable so the test can switch bills mid-session) ─────────────
const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' } as {
    state: unknown; pathname: string; hash: string; search: string
  },
  loaderData: null as unknown, // bill provided by the route loader (useLoaderData)
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

vi.mock('../lib/scrollUtils', () => ({ getScrollContainer: () => ({ scrollTo: vi.fn() }) }))

// Stub the editor with a REAL uncontrolled textarea. An uncontrolled element keeps
// its typed DOM value across re-renders unless React unmounts and remounts it — so
// this stub reveals whether BillDetail keys the composer on the bill (remount =
// cleared) or reuses one instance across bills (stale text persists).
vi.mock('../components/RichTextEditor', () => ({
  RichTextEditor: () => <textarea data-testid="comment-composer" defaultValue="" />,
}))

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'member', subtitle: null },
    loading: false,
  }),
}))
vi.mock('../context/DemoContext', () => ({ useDemo: () => ({ demoLocked: false }) }))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({ useNotifications: () => ({ unreadCount: 0, refresh: vi.fn() }) }))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

function makeBill(id: string, billNumber: string) {
  return {
    id, externalId: `legiscan:${id}`, billNumber, title: `Bill ${billNumber}`,
    state: 'RI', status: 'Introduced', statusDate: null, session: '2025-2026',
    sessionId: '1', sessionSlug: '2025-2026', yearStart: 2025, yearEnd: 2026,
    description: null, billType: null, body: null, currentBody: null, abstract: null,
    stateLink: null, stateUrl: null, url: null, legiscanUrl: null, committee: null,
    referrals: [], tenantSummary: 'Summary.', tags: [], relevanceScore: 5, priority: null,
    textR2Key: null, sponsor: null, sponsorParty: null, sponsorUrl: null, coSponsors: [],
    lastAction: null, lastActionDate: null, history: [], voteSummary: [], subjects: [],
    relatedBillIds: [], companionBillIds: [], texts: [], calendar: [], supplements: [],
    amendments: [], customFieldValues: {}, matchType: 'keyword' as const, isDraft: false,
    draftText: null, createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00',
    centralSyncedAt: null, aiProcessedAt: null, aiSkipReason: null, lastAiTextDocId: null,
    textStatus: 'not_checked' as const, myVote: null, myNote: null, priorityMeta: null,
    position: null, voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 },
    memberVotes: [], comments: [], commentsTotal: 0,
  }
}

const CONFIG = {
  associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'], instanceDomains: {}, orgNoun: 'association',
}

beforeEach(() => {
  vi.restoreAllMocks()
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
  routerMock.loaderData = makeBill('42', 'HB 1')
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
})

describe('BillDetail comment composer draft isolation', () => {
  // Regression: typing a comment on bill A, then navigating to bill B via the
  // sidebar (prefetch path — no spinner, page stays mounted) left bill A's draft
  // text in the composer on bill B. The composer must reset per bill.
  it('clears the new-comment draft when navigating to a different bill', async () => {
    const user = userEvent.setup()
    // Keep ONE mounted tree and rerender it — mirrors the real bug, where bill→bill
    // navigation swaps data without unmounting BillDetail. Two separate render()
    // calls would remount and clear the composer even without the fix.
    const { rerender } = render(<MemoryRouter><BillDetail /></MemoryRouter>)

    await screen.findByText('Bill HB 1')
    const composer = screen.getByTestId('comment-composer') as HTMLTextAreaElement
    await user.type(composer, 'my private draft about bill A')
    expect(composer.value).toBe('my private draft about bill A')

    // Navigate to bill B exactly as the sidebar does: new params + the loader
    // resolving bill B, so BillDetail swaps data without unmounting (no spinner).
    routerMock.params = { billId: '99' }
    routerMock.location = { state: null, pathname: '/bills/99', hash: '', search: '' }
    routerMock.loaderData = makeBill('99', 'SB 2')
    rerender(<MemoryRouter><BillDetail /></MemoryRouter>)

    await screen.findByText('Bill SB 2')
    const composerB = screen.getByTestId('comment-composer') as HTMLTextAreaElement
    expect(composerB.value).toBe('')
  })
})
