import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// Unlike the other BillDetail tests, this one runs a real router location, so the
// committee line's in-page link really changes the hash.
const routerMock = vi.hoisted(() => ({ loaderData: null as unknown }))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useParams: () => ({ billId: '42' }),
    useNavigate: () => vi.fn(),
    useNavigation: () => ({ state: 'idle' }),
    useLoaderData: () => routerMock.loaderData,
  }
})

const scroll = vi.hoisted(() => ({ scrollTo: vi.fn() }))
vi.mock('../lib/scrollUtils', () => ({ getScrollContainer: () => scroll }))

vi.mock('../components/RichTextEditor', () => ({ RichTextEditor: () => null }))
vi.mock('../components/PositionBadge', () => ({ PositionBadge: ({ position }: { position: string }) => <span>{position}</span> }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'member', subtitle: null, canVote: false }, loading: false }),
}))
vi.mock('../context/DemoContext', () => ({ useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }) }))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn() }),
}))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

const BILL = {
  id: '42', externalId: 'legiscan:42', billNumber: 'HB 1', title: 'Test Bill', state: 'RI', status: 'Introduced',
  statusDate: null, session: '2025-2026', sessionId: '1', sessionSlug: '2025-2026', yearStart: 2025, yearEnd: 2026,
  description: null, billType: null, body: null, currentBody: null, abstract: null, stateLink: null, stateUrl: null,
  url: null, legiscanUrl: null,
  committee: { committeeId: '7001', name: 'Judiciary', chamber: 'S' },
  referrals: [{ date: '2026-03-02', committeeId: '7001', name: 'Judiciary', chamber: 'S' }],
  tenantSummary: 'This bill does things.', tags: [], relevanceScore: 85, priority: null, textR2Key: null,
  sponsor: null, sponsorParty: null, sponsorUrl: null, coSponsors: [],
  lastAction: 'Referred to Judiciary', lastActionDate: '2026-03-02',
  history: [{ date: '2026-03-02', action: 'Referred to Judiciary', chamber: 'S' }],
  voteSummary: [], subjects: [], relatedBillIds: [], companionBillIds: [], texts: [], calendar: [], supplements: [],
  amendments: [], customFieldValues: {}, matchType: 'keyword' as const, isDraft: false, draftText: null,
  createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00', centralSyncedAt: null, aiProcessedAt: null,
  aiSkipReason: null, lastAiTextDocId: null, textStatus: 'not_checked' as const, myVote: null, myNote: null,
  priorityMeta: null, position: null, voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 },
  memberVotes: [], comments: [], commentsTotal: 0,
}

const CONFIG = {
  associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'], states: ['RI'],
  instanceDomains: {}, orgNoun: 'association',
}

function renderBill(overrides: Record<string, unknown> = {}) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    return {} as never
  })
  render(<MemoryRouter initialEntries={['/bills/42']}><BillDetail /></MemoryRouter>)
}

// The section scroll passes an options object; the scroll-to-top on arrival passes (0, 0).
const sectionScrolls = () => scroll.scrollTo.mock.calls.filter(([arg]) => typeof arg === 'object')

beforeEach(() => {
  vi.restoreAllMocks()
  scroll.scrollTo.mockClear()
})

describe('the committee line on a bill page', () => {
  it('opens and scrolls to Legislative History every time it is clicked, not only the first', async () => {
    const user = userEvent.setup()
    renderBill()
    const link = await screen.findByRole('link', { name: /Judiciary \(Senate\)/ })
    const actions = await screen.findByRole('button', { name: /^Actions/ })
    expect(actions).toHaveAttribute('aria-expanded', 'false')

    await user.click(link)
    await waitFor(() => expect(actions).toHaveAttribute('aria-expanded', 'true'))
    await waitFor(() => expect(sectionScrolls()).toHaveLength(1))

    // The reader collapses the section and clicks again, with the hash unchanged.
    await user.click(actions)
    expect(actions).toHaveAttribute('aria-expanded', 'false')
    await user.click(link)
    await waitFor(() => expect(actions).toHaveAttribute('aria-expanded', 'true'))
    await waitFor(() => expect(sectionScrolls()).toHaveLength(2))
  })

  it('is plain text, with no link, when the bill has no Legislative History section to go to', async () => {
    renderBill({ lastAction: null, lastActionDate: null, history: [], committee: null })
    expect(await screen.findByText('Last referred to:')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Judiciary/ })).not.toBeInTheDocument()
    expect(screen.getByText('Last referred to:').parentElement).toHaveTextContent('Last referred to: Judiciary (Senate), Mar 2026')
  })
})
