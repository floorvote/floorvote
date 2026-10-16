import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
  useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn() }),
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



function renderBillDetail(overrides: Record<string, unknown>) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles' || path === '/users') return [] as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})

const comment = (id: string, billId: string, billNumber: string, createdAt: string, userName: string) => ({
  id, billId, billNumber, userId: `u-${userName}`, userName, userSubtitle: null,
  content: `<p>${id} text</p>`, createdAt, reactions: [],
})

// Bill 42 is A190 here, grouped with S1713 on October 11.
const GROUPED = {
  billNumber: 'A190',
  state: 'NJ',
  comments: [
    comment('c1', '42', 'A190', '2026-10-10 12:00:00', 'Ann'),
    comment('c2', 'b1713', 'S1713', '2026-10-10 13:00:00', 'Ben'),
    comment('c3', '42', 'A190', '2026-10-12 12:00:00', 'Ann'),
  ],
  commentsTotal: 3,
  groupingEvents: [
    { id: 'g1', type: 'grouped', createdAt: '2026-10-11 12:00:00', actorName: null, with: [{ billId: 'b1713', billNumber: 'S1713' }] },
  ],
}

describe('the comment thread of a grouped bill', () => {
  it("tags a comment posted on the companion with that bill's number, and no other", async () => {
    renderBillDetail(GROUPED)
    await screen.findByText('c2 text')
    expect(document.getElementById('comment-c2')?.textContent).toContain('S1713')
    expect(document.getElementById('comment-c1')?.textContent).not.toContain('A190')
  })

  it('shows the grouping line where the group formed, between the comments before and after', async () => {
    renderBillDetail({ ...GROUPED, groupingEvents: [{ ...GROUPED.groupingEvents[0], commentBills: [{ billId: 'b1713', billNumber: 'S1713' }] }] })
    const line = await screen.findByText('Grouped with S1713 as identical bills on October 11. Earlier comments on S1713 now appear here.')
    const before = screen.getByText('c2 text')
    const after = screen.getByText('c3 text')
    expect(before.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(line.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the personal note of a grouped bill', () => {
  it("shows the member's notes from both bills under their numbers", async () => {
    renderBillDetail({
      ...GROUPED,
      myNote: '<p><strong>A190</strong></p><p>Mine on A190</p><p><strong>S1713</strong></p><p>Mine on S1713</p>',
      myNotes: [
        { billId: '42', billNumber: 'A190', content: '<p>Mine on A190</p>', updatedAt: '2026-10-01 00:00:00' },
        { billId: 'b1713', billNumber: 'S1713', content: '<p>Mine on S1713</p>', updatedAt: '2026-10-01 00:00:00' },
      ],
    })
    expect(await screen.findByRole('heading', { name: 'S1713' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'A190' })).toBeInTheDocument()
    expect(screen.getByText('Mine on S1713')).toBeInTheDocument()
  })
})

// Which grouping and split lines the thread shows. FloorVote's own lines appear only when they explain a
// change to the thread: a comment posted, before the event, on a bill it joined or left. An admin's lines
// and the lines that list replaced values or undone splits always appear.
describe('the grouping lines of a comment thread', () => {
  const S1713 = { billId: 'b1713', billNumber: 'S1713' }
  const A190 = { billId: '42', billNumber: 'A190' }
  const grouped = (over: Record<string, unknown> = {}) =>
    ({ id: 'g1', type: 'grouped', createdAt: '2026-10-11 12:00:00', actorName: null, with: [S1713], commentBills: [], replaced: [], ...over })
  const split = (over: Record<string, unknown> = {}) =>
    ({ id: 's1', type: 'split', createdAt: '2026-10-13 12:00:00', actorName: null, with: [S1713], commentBills: [], replaced: [], ...over })
  const lines = () => screen.queryAllByRole('note').map(n => n.textContent)
  const thread = { comments: GROUPED.comments, commentsTotal: 3 }

  it('shows no line for an automatic grouping that explains nothing, in a thread with comments', async () => {
    renderBillDetail({ ...GROUPED, groupingEvents: [grouped()] })
    await screen.findByText('c3 text')
    expect(lines()).toEqual([])
    expect(screen.queryByText(/Grouped with/)).not.toBeInTheDocument()
  })

  it('shows no line for an automatic grouping in an empty thread', async () => {
    renderBillDetail({ ...GROUPED, comments: [], commentsTotal: 0, groupingEvents: [grouped()] })
    await screen.findByText('A190', { exact: false })
    expect(lines()).toEqual([])
    expect(screen.queryByText(/Grouped with/)).not.toBeInTheDocument()
  })

  it('shows the line, naming the bill, when an automatic grouping brought earlier comments', async () => {
    renderBillDetail({ ...GROUPED, groupingEvents: [grouped({ commentBills: [S1713] })] })
    expect(await screen.findByText('Grouped with S1713 as identical bills on October 11. Earlier comments on S1713 now appear here.')).toBeInTheDocument()
    expect(lines()).toHaveLength(1)
  })

  it('shows the line after every comment when the grouping is the latest thing in the thread', async () => {
    renderBillDetail({ ...GROUPED, groupingEvents: [grouped({ createdAt: '2026-10-20 12:00:00', commentBills: [S1713] })] })
    const line = await screen.findByText('Grouped with S1713 as identical bills on October 20. Earlier comments on S1713 now appear here.')
    expect(screen.getByText('c3 text').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows no line for an automatic split that took no comments away', async () => {
    renderBillDetail({ ...thread, groupingEvents: [grouped(), split()] })
    await screen.findByText('c3 text')
    expect(lines()).toEqual([])
  })

  it('says comments posted on the bill that left no longer appear, for an automatic split with comments on it', async () => {
    renderBillDetail({ ...thread, groupingEvents: [grouped(), split({ commentBills: [S1713] })] })
    expect(await screen.findByText('Separated from S1713 on October 13. Comments posted on S1713 no longer appear here.')).toBeInTheDocument()
    expect(lines()).toHaveLength(1)
  })

  it('still shows the line naming the admin who grouped by hand, without a comments sentence', async () => {
    renderBillDetail({ ...GROUPED, groupingEvents: [grouped({ actorName: 'Ada' })] })
    expect(await screen.findByText('Ada grouped this bill with S1713 on October 11.')).toBeInTheDocument()
  })

  it('still shows the line naming the admin who split by hand, without a comments sentence, even in an empty thread', async () => {
    renderBillDetail({ ...GROUPED, comments: [], commentsTotal: 0, groupingEvents: [split({ actorName: 'Ada' })] })
    expect(await screen.findByText('Ada separated this bill from S1713 on October 13.')).toBeInTheDocument()
  })

  it('still shows the line for an automatic grouping that replaced a team value, without a comments sentence', async () => {
    const replaced = [{ field: 'position', label: 'position', billId: 'b1713', billNumber: 'S1713', value: 'Oppose', replacedBy: { billId: '42', billNumber: 'A190', value: 'Support' } }]
    renderBillDetail({ ...GROUPED, groupingEvents: [grouped({ replaced })] })
    expect(await screen.findByText("Grouped with S1713 as identical bills on October 11. S1713's position, Oppose, was replaced by A190's, Support.")).toBeInTheDocument()
  })

  it('still shows the line for an automatic grouping that undid splits', async () => {
    renderBillDetail({ ...GROUPED, groupingEvents: [grouped({ undoneSplits: [[A190, S1713]] })] })
    expect(await screen.findByText('Grouped with S1713 as identical bills on October 11. It undid the split of A190 and S1713.')).toBeInTheDocument()
  })

  it('names only the joined bills that had earlier comments when three bills grouped at once', async () => {
    const S1714 = { billId: 'c1714', billNumber: 'S1714' }
    renderBillDetail({ ...GROUPED, groupingEvents: [grouped({ with: [S1713, S1714], commentBills: [S1713] })] })
    expect(await screen.findByText('Grouped with S1713 and S1714 as identical bills on October 11. Earlier comments on S1713 now appear here.')).toBeInTheDocument()
  })

  it('shows only the lines that explain something among several events', async () => {
    renderBillDetail({ ...GROUPED, groupingEvents: [grouped(), split({ commentBills: [S1713] }), grouped({ id: 'g2', createdAt: '2026-10-14 12:00:00', commentBills: [S1713] })] })
    await screen.findByText('c3 text')
    expect(lines()).toEqual([
      'link_off' + 'Separated from S1713 on October 13. Comments posted on S1713 no longer appear here.',
      'link_2' + 'Grouped with S1713 as identical bills on October 14. Earlier comments on S1713 now appear here.',
    ])
  })

  it('renders an event from an older server that sends no commentBills as an automatic line with nothing to explain', async () => {
    const { commentBills: _omit, ...old } = grouped()
    renderBillDetail({ ...GROUPED, groupingEvents: [old] })
    await screen.findByText('c3 text')
    expect(lines()).toEqual([])
  })
})
