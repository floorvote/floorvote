import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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

vi.mock('../components/RichTextEditor', () => ({
  RichTextEditor: () => <textarea data-testid="comment-composer" defaultValue="" />,
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

const CONFIG = {
  associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'], instanceDomains: {}, orgNoun: 'association',
}

let apiSpy: MockInstance<typeof api.apiFetch>

beforeEach(() => {
  vi.restoreAllMocks()
  authMock.emailRepliesEnabled = true
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
  routerMock.loaderData = makeBill('42', 'HB 1')
  apiSpy = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    if (path === '/bills/42/mute') return { muted: init?.method === 'PUT' } as never
    return {} as never
  })
})

const commentsSection = () => document.getElementById('section-comments') as HTMLElement
const muteCalls = () => apiSpy.mock.calls
  .filter(([path]) => path === '/bills/42/mute')
  .map(([, init]) => (init as RequestInit | undefined)?.method)

const MUTE_TIP = "You're notified of new comments here because you've commented on this bill. Mute to stop for this bill only. Mentions still reach you."
const UNMUTE_TIP = "You've muted this bill, so you won't be notified of new comments here. Mentions still reach you."

// Mute sits with the comments, for a participant (someone who would get reply
// notifications: they commented on the bill or its companion group) whose
// "Replies on bills you've commented on" setting is on. A member who already
// has a mute gets Unmute while the setting is on. With the setting off the
// control is hidden entirely, since replies are off for every bill. The route
// decides who counts, as `commentsParticipant`, with the helper the reply
// emails use.
describe('BillDetail mute comments', () => {
  it('mutes the bill\'s comments from the comments section', async () => {
    routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsParticipant: true }
    const user = userEvent.setup()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    await user.click(within(commentsSection()).getByRole('button', { name: 'Mute comments' }))

    expect(muteCalls()).toEqual(['PUT'])
    expect(await within(commentsSection()).findByRole('button', { name: 'Unmute comments' })).toBeInTheDocument()
  })

  it('unmutes a muted bill', async () => {
    routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsMuted: true, commentsParticipant: true }
    const user = userEvent.setup()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    await user.click(within(commentsSection()).getByRole('button', { name: 'Unmute comments' }))

    expect(muteCalls()).toEqual(['DELETE'])
    expect(await within(commentsSection()).findByRole('button', { name: 'Mute comments' })).toBeInTheDocument()
  })

  it('puts the toggle back when the request fails', async () => {
    routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsParticipant: true }
    apiSpy.mockImplementation(async (path: string) => {
      if (path === '/config') return { ...CONFIG } as never
      if (path === '/config/custom-fields' || path === '/roles' || path === '/users') return [] as never
      if (path === '/bills/42/mute') throw new api.ApiError(500, 'Server error')
      return {} as never
    })
    const user = userEvent.setup()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    await user.click(within(commentsSection()).getByRole('button', { name: 'Mute comments' }))

    expect(muteCalls()).toEqual(['PUT'])
    expect(await within(commentsSection()).findByRole('button', { name: 'Mute comments' })).toBeInTheDocument()
    expect(screen.queryByText(UNMUTE_TIP)).not.toBeInTheDocument()
  })

  it('shows no mute control to a member who has not commented on the bill or its group', async () => {
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    expect(within(commentsSection()).queryByRole('button', { name: /mute comments/i })).not.toBeInTheDocument()
    expect(within(commentsSection()).queryByText(/mentions still reach you/i)).not.toBeInTheDocument()
  })

  it('shows Unmute to a muted member who never commented, and unmuting works', async () => {
    routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsMuted: true, commentsParticipant: false }
    const user = userEvent.setup()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    await user.click(within(commentsSection()).getByRole('button', { name: 'Unmute comments' }))

    expect(muteCalls()).toEqual(['DELETE'])
    expect(await within(commentsSection()).findByRole('button', { name: 'Mute comments' })).toHaveAccessibleDescription(MUTE_TIP)
  })

  it('keeps the control on the page after a non-participant unmutes, so the click does not make it vanish', async () => {
    routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsMuted: true, commentsParticipant: false }
    const user = userEvent.setup()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    await user.click(within(commentsSection()).getByRole('button', { name: 'Unmute comments' }))

    expect(await within(commentsSection()).findByRole('button', { name: 'Mute comments' })).toBeInTheDocument()
  })

  it('follows the bill when the member moves from a bill they commented on to one they did not', async () => {
    routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsParticipant: true }
    const { rerender } = render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')
    expect(within(commentsSection()).getByRole('button', { name: 'Mute comments' })).toBeInTheDocument()

    routerMock.params = { billId: '43' }
    routerMock.location = { state: null, pathname: '/bills/43', hash: '', search: '' }
    routerMock.loaderData = makeBill('43', 'HB 2')
    rerender(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 2')

    expect(within(commentsSection()).queryByRole('button', { name: /mute comments/i })).not.toBeInTheDocument()
  })

  // A comment posted from this page is added to the list without refetching the
  // bill, so the page has to count the member's own comment as it appears.
  it('offers Mute as soon as the member\'s own comment is on the page, without a refetch', async () => {
    routerMock.loaderData = {
      ...makeBill('42', 'HB 1'),
      comments: [{ id: 'c1', userId: 'u1', userName: 'Alice', userTitle: null, content: '<p>Just posted</p>', createdAt: '2025-01-02 00:00:00', reactions: [] }],
      commentsTotal: 1,
    }
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    expect(within(commentsSection()).getByRole('button', { name: 'Mute comments' })).toBeInTheDocument()
  })

  it('offers no Mute to a member whose page shows only other people\'s comments', async () => {
    routerMock.loaderData = {
      ...makeBill('42', 'HB 1'),
      comments: [{ id: 'c1', userId: 'u2', userName: 'Bob', userTitle: null, content: '<p>Hello</p>', createdAt: '2025-01-02 00:00:00', reactions: [] }],
      commentsTotal: 1,
    }
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    expect(within(commentsSection()).queryByRole('button', { name: /mute comments/i })).not.toBeInTheDocument()
  })

  describe('when the member turned "Replies on bills you\'ve commented on" off', () => {
    beforeEach(() => { authMock.emailRepliesEnabled = false })

    it('hides Mute from a participant', async () => {
      routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsParticipant: true }
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')

      expect(within(commentsSection()).queryByRole('button', { name: /mute comments/i })).not.toBeInTheDocument()
    })

    it('hides Unmute from a member who muted the bill earlier', async () => {
      routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsMuted: true, commentsParticipant: true }
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')

      expect(within(commentsSection()).queryByRole('button', { name: /mute comments/i })).not.toBeInTheDocument()
    })

    it('hides Unmute from a muted member who never commented', async () => {
      routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsMuted: true, commentsParticipant: false }
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')

      expect(within(commentsSection()).queryByRole('button', { name: /mute comments/i })).not.toBeInTheDocument()
    })

    it('hides Mute from a member whose own comment is on the page', async () => {
      routerMock.loaderData = {
        ...makeBill('42', 'HB 1'),
        comments: [{ id: 'c1', userId: 'u1', userName: 'Alice', userTitle: null, content: '<p>Just posted</p>', createdAt: '2025-01-02 00:00:00', reactions: [] }],
        commentsTotal: 1,
      }
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')

      expect(within(commentsSection()).queryByRole('button', { name: /mute comments/i })).not.toBeInTheDocument()
    })

    it('shows Mute again once the setting is back on', async () => {
      routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsParticipant: true }
      const { rerender } = render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')
      expect(within(commentsSection()).queryByRole('button', { name: /mute comments/i })).not.toBeInTheDocument()

      authMock.emailRepliesEnabled = true
      rerender(<MemoryRouter><BillDetail /></MemoryRouter>)

      expect(within(commentsSection()).getByRole('button', { name: 'Mute comments' })).toBeInTheDocument()
    })
  })

  describe('the hover on the button', () => {
    it('explains Mute, on hover and to a screen reader', async () => {
      routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsParticipant: true }
      const user = userEvent.setup()
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')
      const button = within(commentsSection()).getByRole('button', { name: 'Mute comments' })

      expect(button).toHaveAccessibleDescription(MUTE_TIP)
      await user.hover(button)

      // The visible bubble, plus the screen-reader copy the button points to.
      expect(screen.getAllByText(MUTE_TIP)).toHaveLength(2)
    })

    it('explains Unmute, on hover and to a screen reader', async () => {
      routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsMuted: true, commentsParticipant: true }
      const user = userEvent.setup()
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')
      const button = within(commentsSection()).getByRole('button', { name: 'Unmute comments' })

      expect(button).toHaveAccessibleDescription(UNMUTE_TIP)
      await user.hover(button)

      expect(screen.getAllByText(UNMUTE_TIP)).toHaveLength(2)
    })

    it('swaps the explanation when the member mutes', async () => {
      routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsParticipant: true }
      const user = userEvent.setup()
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')

      await user.click(within(commentsSection()).getByRole('button', { name: 'Mute comments' }))

      const unmute = await within(commentsSection()).findByRole('button', { name: 'Unmute comments' })
      expect(unmute).toHaveAccessibleDescription(UNMUTE_TIP)
      expect(screen.queryByText(MUTE_TIP)).not.toBeInTheDocument()
    })

    it('shows no bubble until the pointer is on the button', async () => {
      routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsParticipant: true }
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Bill HB 1')

      expect(screen.getAllByText(MUTE_TIP)).toHaveLength(1)
    })
  })

  it('has no muted-note line under the heading, muted or not', async () => {
    routerMock.loaderData = { ...makeBill('42', 'HB 1'), commentsMuted: true, commentsParticipant: true }
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Bill HB 1')

    expect(within(commentsSection()).queryByText(/you won't be notified of new comments on this bill/i)).not.toBeInTheDocument()
    expect(commentsSection().querySelectorAll('p')).toHaveLength(0)
  })
})
