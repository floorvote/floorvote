import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
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

// The composer is stood in for: what matters here is what BillDetail hands it and does with its post.
const composer = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }))
vi.mock('../components/RichTextEditor', () => ({
  RichTextEditor: (props: { attachments?: unknown; onSubmit?: (html: string, ids: string[]) => void; placeholder?: string }) => {
    if (props.placeholder === 'Add a comment…') composer.props.push(props as Record<string, unknown>)
    return <button type="button" data-testid="comment-composer" onClick={() => props.onSubmit?.('<p>hi</p>', ['att1'])}>post</button>
  },
}))

// The member's "Replies on bills you've commented on" setting rides on the
// signed-in user, so the test flips it here.
const authMock = vi.hoisted(() => ({ emailRepliesEnabled: true }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'member', subtitle: null, emailRepliesEnabled: authMock.emailRepliesEnabled },
    loading: false,
  }),
}))
vi.mock('../context/DemoContext', () => ({ useDemo: () => ({ demoLocked: false }) }))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({ useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn() }) }))
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
    relatedBillIds: [], texts: [], calendar: [], supplements: [],
    amendments: [], customFieldValues: {}, matchType: 'keyword' as const, isDraft: false,
    draftText: null, createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00',
    centralSyncedAt: null, aiProcessedAt: null, aiSkipReason: null, lastAiTextDocId: null,
    textStatus: 'not_checked' as const, myVote: null, myNote: null, priorityMeta: null,
    position: null, voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 },
    memberVotes: [], comments: [], commentsTotal: 0, commentsMuted: false, commentsParticipant: false,
  }
}

const LIMITS = { maxBytes: 26214400, maxPerComment: 10 }
const FILE = { id: 'att7', name: 'Fiscal Note.pdf', contentType: 'application/pdf', size: 2048 }
const CONFIG: Record<string, unknown> = {
  associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'], instanceDomains: {}, orgNoun: 'association',
}

let apiSpy: MockInstance<typeof api.apiFetch>

beforeEach(() => {
  vi.restoreAllMocks()
  authMock.emailRepliesEnabled = true
  composer.props.length = 0
  delete CONFIG.attachments
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
  routerMock.loaderData = makeBill('42', 'HB 1')
  apiSpy = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    if (path === '/bills/42/mute') return { muted: init?.method === 'PUT' } as never
    if (path === '/bills/42/comments' && init?.method === 'POST') return { id: 'c9', content: '<p>hi</p>', createdAt: '2026-10-19 12:00:00', attachments: [FILE] } as never
    return {} as never
  })
})


const lastComposer = () => composer.props[composer.props.length - 1]

describe('BillDetail comment attachments', () => {
  it('gives the composer the limits when the instance has attachments on', async () => {
    CONFIG.attachments = LIMITS
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')
    await waitFor(() => expect(lastComposer().attachments).toEqual(LIMITS))
  })

  it('leaves attachments off for the composer when /config says null', async () => {
    CONFIG.attachments = null
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')
    expect(lastComposer().attachments ?? null).toBeNull()
  })

  it('shows the files on a posted comment', async () => {
    routerMock.loaderData = {
      ...makeBill('42', 'HB 1'), commentsTotal: 1,
      comments: [{ id: 'c1', userId: 'u2', userName: 'Bo', userTitle: null, content: '<p>see attached</p>', createdAt: '2026-10-11 12:00:00', reactions: [], attachments: [FILE] }],
    }
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')
    const list = within(document.getElementById('section-comments') as HTMLElement).getByRole('list', { name: 'Attachments' })
    expect(list).toHaveTextContent('Fiscal Note.pdf')
    expect(within(list).getByRole('link', { name: 'Download Fiscal Note.pdf' })).toHaveAttribute('href', '/api/attachments/att7')
  })

  it('sends the uploaded ids with the comment and shows the files it posted', async () => {
    CONFIG.attachments = LIMITS
    const user = userEvent.setup()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')
    await user.click(screen.getByTestId('comment-composer'))
    const post = apiSpy.mock.calls.find(([p, i]) => p === '/bills/42/comments' && (i as RequestInit | undefined)?.method === 'POST')!
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ content: '<p>hi</p>', attachmentIds: ['att1'] })
    expect(await within(document.getElementById('section-comments') as HTMLElement).findByRole('link', { name: 'Download Fiscal Note.pdf' })).toBeInTheDocument()
  })

  it('posts a comment with no files exactly as before', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')
    // The stand-in always hands back att1; the real composer hands back [] with no files.
    composer.props.length = 0
    apiSpy.mockClear()
    await user.click(screen.getByTestId('comment-composer'))
    const post = apiSpy.mock.calls.find(([p]) => p === '/bills/42/comments')!
    expect(JSON.parse((post[1] as RequestInit).body as string).content).toBe('<p>hi</p>')
  })
})
