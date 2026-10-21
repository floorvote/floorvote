import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'
import { CARD } from '../lib/cardStyle'

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
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, canVote: authState.canVote },
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



function renderBillDetail(overrides: Record<string, unknown>, config: Record<string, unknown> = {}, customFields: unknown[] = []) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG, ...config } as never
    if (path === '/config/custom-fields') return customFields as never
    if (path === '/roles' || path === '/users') return [] as never
    return {} as never
  })
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})

const comment = (id: string, billId: string, billNumber: string, createdAt: string, userName: string) => ({
  id, billId, billNumber, userId: `u-${userName}`, userName,
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

// The header's first row holds this page's bill alone: its badge and its status. The group's other bills
// sit on a quieter "Grouped with" line below it, each with its own status, since the status, sponsors, and
// referrals above and below belong to this bill only.
const link = (billId: string, billNumber: string, state = 'NJ', sessionSlug = '2026', status = '') => ({ billId, billNumber, state, sessionSlug, status })
const THIS = link('42', 'A190', 'NJ', '2026', 'Introduced')
const COMPANION = link('b1713', 'S1713', 'NJ', '2025-2026', 'Passed')
const THIRD = link('c2000', 'H2000', 'NJ', '2026', 'Vetoed')

describe('the header of a grouped bill', () => {
  // The header's first row: the page bill's badge wrapper sits in it, with the status chip beside it.
  const firstRow = () => screen.getByTestId('bill-header-badge').parentElement!
  const groupedWith = () => screen.getByTestId('grouped-with-line')
  const members = () => within(groupedWith()).getAllByTestId('grouped-with-member')

  it("shows only this bill's badge and status in the first row, with no link to a companion", async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION, THIRD] })
    await screen.findByText('c1 text')
    const row = within(firstRow())
    expect(row.getByText('A190').closest('a')).toBeNull()
    expect(row.getByRole('button', { name: 'Introduced' })).toBeInTheDocument()
    expect(row.queryByText('S1713')).toBeNull()
    expect(row.queryByText('H2000')).toBeNull()
    expect(row.queryByRole('link')).toBeNull()
    // The page bill's badge comes first in the row, its status after.
    expect(row.getByText('A190').compareDocumentPosition(row.getByText('Introduced')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('names the "Grouped with" line as a group for screen readers', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION] })
    await screen.findByText('c1 text')
    expect(screen.getByRole('group', { name: 'Grouped with' })).toBe(groupedWith())
  })

  it('puts a "Grouped with" line below the first row, above the title', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION] })
    await screen.findByText('c1 text')
    expect(within(groupedWith()).getByText('Grouped with')).toBeInTheDocument()
    expect(firstRow().contains(groupedWith())).toBe(false)
    expect(firstRow().compareDocumentPosition(groupedWith()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(groupedWith().compareDocumentPosition(screen.getByRole('heading', { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("lists the companion as a badge linking to its canonical bill page, followed by its own status", async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION] })
    await screen.findByText('c1 text')
    const [member] = members()
    const badge = within(member).getByRole('link', { name: 'S1713' })
    expect(badge).toHaveAttribute('href', '/NJ/2025-2026/S1713')
    expect(within(member).getAllByRole('link')).toHaveLength(1)
    expect(within(member).getByText('Passed')).toBeInTheDocument()
    expect(badge.compareDocumentPosition(within(member).getByText('Passed')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The page bill is not listed in its own line.
    expect(within(groupedWith()).queryByText('A190')).toBeNull()
  })

  it("gives each companion of a group of three its own status, not this bill's", async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION, THIRD] })
    await screen.findByText('c1 text')
    expect(members().map(m => [within(m).getByRole('link').textContent, within(m).getByRole('link').getAttribute('href'), m.textContent])).toEqual([
      ['S1713', '/NJ/2025-2026/S1713', 'S1713Passed'],
      ['H2000', '/NJ/2026/H2000', 'H2000Vetoed'],
    ])
    expect(within(groupedWith()).queryByText('Introduced')).toBeNull()
  })

  it('keeps the order the group bills arrive in, this bill left out', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, THIRD, COMPANION] })
    await screen.findByText('c1 text')
    expect(members().map(m => within(m).getByRole('link').textContent)).toEqual(['H2000', 'S1713'])
  })

  it("decodes a companion's status stored as a code, as the page's own status is", async () => {
    renderBillDetail({ ...GROUPED, status: '1', groupBills: [{ ...THIS, status: '1' }, { ...COMPANION, status: '4' }] })
    await screen.findByText('c1 text')
    expect(within(members()[0]).getByText('Passed')).toBeInTheDocument()
    expect(within(firstRow()).getByRole('button', { name: 'Introduced' })).toBeInTheDocument()
  })

  it('shows no status pill for a companion whose status is empty, but still lists its badge', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, { ...COMPANION, status: '' }] })
    await screen.findByText('c1 text')
    expect(members()[0].textContent).toBe('S1713')
    expect(within(members()[0]).getByRole('link', { name: 'S1713' })).toBeInTheDocument()
  })

  it("draws a companion's badge and status small, below the first row's sizes, and its status as plain text", async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION] })
    await screen.findByText('c1 text')
    const inLine = within(groupedWith()).getByRole('link', { name: 'S1713' })
    const pageBadge = within(firstRow()).getByText('A190').closest('span')!
    expect(parseFloat(inLine.style.fontSize)).toBeLessThan(parseFloat(pageBadge.style.fontSize))
    const miniStatus = within(members()[0]).getByText('Passed')
    const pageStatus = within(firstRow()).getByText('Introduced')
    expect(parseFloat(miniStatus.style.fontSize)).toBeLessThan(parseFloat(pageStatus.style.fontSize))
    // Not a second control beside the badge's link: filtering the list by a companion's status is the page status's job.
    expect(miniStatus.closest('button')).toBeNull()
    expect(miniStatus.closest('a')).toBeNull()
  })

  it('lets the line wrap, so a long status on a narrow screen drops to the next row', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION, THIRD] })
    await screen.findByText('c1 text')
    expect(groupedWith().style.flexWrap).toBe('wrap')
    members().forEach(m => expect(m.style.whiteSpace).toBe('nowrap'))
  })

  it('shows one badge in the first row and no "Grouped with" line for a bill in no group', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS], groupingEvents: [], comments: [], commentsTotal: 0 })
    await screen.findByText('Test Bill')
    expect(screen.getAllByText('A190')).toHaveLength(1)
    expect(screen.getByText('A190').closest('a')).toBeNull()
    expect(screen.queryByTestId('grouped-with-line')).toBeNull()
    expect(screen.queryByText('Grouped with')).toBeNull()
    expect(screen.queryByRole('link', { name: 'S1713' })).toBeNull()
    expect(within(firstRow()).getByRole('button', { name: 'Introduced' })).toBeInTheDocument()
  })

  it('shows no line when the response carries no group bills at all', async () => {
    renderBillDetail({ ...GROUPED, groupBills: undefined, groupingEvents: [] })
    await screen.findByText('Test Bill')
    expect(screen.getAllByText('A190')).toHaveLength(1)
    expect(screen.getByText('A190').closest('a')).toBeNull()
    expect(screen.queryByTestId('grouped-with-line')).toBeNull()
  })

  it('leaves a draft bill header as it was: its one dashed badge and the draft chip, with no line', async () => {
    renderBillDetail({ billNumber: 'D1', isDraft: true, state: 'NJ', groupBills: [link('42', 'D1')], groupingEvents: [], comments: [], commentsTotal: 0 })
    await screen.findByText('Test Bill')
    expect(screen.getAllByText('D1')).toHaveLength(1)
    expect(screen.getByText('D1').closest('a')).toBeNull()
    expect(screen.getAllByText(/Draft/).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('grouped-with-line')).toBeNull()
  })

  it('keeps the first row the same for a grouped bill as for a bill in no group', async () => {
    const first = renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION], groupingEvents: [], comments: [], commentsTotal: 0 })
    await screen.findByText('Test Bill')
    const grouped = Array.from(firstRow().children).map(el => el.textContent)
    first.unmount()
    renderBillDetail({ ...GROUPED, groupBills: [THIS], groupingEvents: [], comments: [], commentsTotal: 0 })
    await screen.findByText('Test Bill')
    expect(Array.from(firstRow().children).map(el => el.textContent)).toEqual(grouped)
  })

  it('still offers an admin the group controls in the overflow menu: "Group with…" and "Split from group"', async () => {
    const user = userEvent.setup()
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION] })
    await screen.findByText('c1 text')
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(await screen.findByRole('menuitem', { name: /Group with/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Split from group/ })).toBeInTheDocument()
  })

  it('shows no "Companion:" line, even when the response still carries legacy companion ids', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION], companionBillIds: ['legacy-companion-7'] })
    await screen.findByText('c1 text')
    expect(screen.queryByText('Companion:')).toBeNull()
    expect(screen.queryByText('legacy-companion-7')).toBeNull()
  })

  it('shows no "Companion:" line on a bill in no group either', async () => {
    renderBillDetail({ groupBills: [THIS], companionBillIds: ['legacy-companion-7'], billNumber: 'A190' })
    await screen.findByText('Test Bill')
    expect(screen.queryByText('Companion:')).toBeNull()
  })
})

// The one muted line above the comments and the org's position that says they
// are shared with the group's other bills, in the page's own terms: Comments,
// member votes, and the configured org noun's position.
describe('the line saying what a companion group shares', () => {
  const SENTENCE_FOR = (names: string, noun = 'association') => `Comments, votes, and ${noun} position are shared with ${names}.`
  const FOURTH = link('d2001', 'S1714', 'NJ', '2026')
  const NO_COMMENTS = { comments: [], commentsTotal: 0, groupingEvents: [] }
  const line = () => screen.getByTestId('group-shares-line')

  it('renders once for a group of two, naming the companion as a link to its canonical bill page', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION] })
    await screen.findByText('Test Bill')
    expect(screen.getAllByTestId('group-shares-line')).toHaveLength(1)
    expect(within(line()).getByRole('link', { name: 'S1713' })).toHaveAttribute('href', '/NJ/2025-2026/S1713')
    expect(line()).toHaveTextContent(SENTENCE_FOR('S1713'))
  })

  it("names the configured org noun's position, as the position card does", async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION] }, { orgNoun: 'alliance' })
    await screen.findByText('Alliance position')
    expect(line()).toHaveTextContent(SENTENCE_FOR('S1713', 'alliance'))
  })

  it('names custom fields too once the instance defines at least one', async () => {
    const field = { id: 'cf1', name: 'Committee lead', slug: null, type: 'text', options: null, displayOrder: 0, pinned: false }
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION] }, {}, [field])
    await waitFor(() => expect(line()).toHaveTextContent('Comments, votes, association position, and custom fields are shared with S1713.'))
  })

  it('falls back to the default noun before /config answers', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION] }, { orgNoun: undefined })
    await screen.findByText('Test Bill')
    expect(line()).toHaveTextContent(SENTENCE_FOR('S1713', 'team'))
  })

  it('sits above the two-column area, below the header', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS, COMPANION] })
    await screen.findByText('c1 text')
    const columns = document.querySelector('.bill-detail-columns')!
    expect(columns).not.toBeNull()
    expect(columns.contains(line())).toBe(false)
    expect(line().compareDocumentPosition(columns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('grouped-with-line').compareDocumentPosition(line()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The comments and the position live in that two-column area, below the line.
    expect(line().compareDocumentPosition(document.getElementById('section-comments')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('names both companions of a group of three as "S1713 and H2000", and never the page\'s own bill', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION, THIRD] })
    await screen.findByText('Test Bill')
    expect(line()).toHaveTextContent(SENTENCE_FOR('S1713 and H2000'))
    expect(line()).not.toHaveTextContent('A190')
    expect(within(line()).getAllByRole('link').map(a => [a.textContent, a.getAttribute('href')])).toEqual([
      ['S1713', '/NJ/2025-2026/S1713'],
      ['H2000', '/NJ/2026/H2000'],
    ])
  })

  it('joins a group of four as "S1713, H2000, and S1714", with the serial comma', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION, THIRD, FOURTH] })
    await screen.findByText('Test Bill')
    expect(line()).toHaveTextContent(SENTENCE_FOR('S1713, H2000, and S1714'))
    expect(line()).not.toHaveTextContent('A190')
    expect(within(line()).getAllByRole('link')).toHaveLength(3)
  })

  it('names the companions in the order the group bills arrive', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, THIRD, COMPANION] })
    await screen.findByText('Test Bill')
    expect(line()).toHaveTextContent(SENTENCE_FOR('H2000 and S1713'))
  })

  it('links a companion with no session slug to /bills/:id', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, { ...COMPANION, sessionSlug: '' }] })
    await screen.findByText('Test Bill')
    expect(within(line()).getByRole('link', { name: 'S1713' })).toHaveAttribute('href', '/bills/b1713')
  })

  it('shows no line on a bill in no group', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS] })
    await screen.findByText('Test Bill')
    expect(screen.queryByTestId('group-shares-line')).toBeNull()
    expect(screen.queryByText(/are shared with/)).toBeNull()
  })

  it('shows no line when the response carries no group bills at all', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: undefined })
    await screen.findByText('Test Bill')
    expect(screen.queryByTestId('group-shares-line')).toBeNull()
  })

  it('shows no line on a draft bill, which is in no group', async () => {
    renderBillDetail({ ...NO_COMMENTS, billNumber: 'D1', isDraft: true, state: 'NJ', groupBills: [link('42', 'D1')] })
    await screen.findByText('Test Bill')
    expect(screen.queryByTestId('group-shares-line')).toBeNull()
    expect(screen.queryByText(/are shared with/)).toBeNull()
  })

  it('renders the same for a standard member as for an admin', async () => {
    authState.role = 'member'
    try {
      renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION] })
      await screen.findByText('Test Bill')
      expect(line()).toHaveTextContent(SENTENCE_FOR('S1713'))
    } finally {
      authState.role = 'admin'
    }
  })

  it('puts no per-field group marker on the position, votes, custom fields, or the note', async () => {
    renderBillDetail({
      ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION],
      customFieldValues: { f1: { value: 'Shared value', setBy: 'Ann', updatedAt: '2026-10-10 12:00:00' } },
    })
    await screen.findByText('Test Bill')
    // The companion's number shows twice and only twice: the header badge and the line.
    expect(screen.getAllByText('S1713')).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'S1713' })).toHaveLength(2)
    // Nothing else on the page says the values are shared.
    expect(screen.getAllByText(/are shared with/)).toHaveLength(1)
    const columns = document.querySelector('.bill-detail-columns')!
    expect(within(columns as HTMLElement).queryByText('S1713')).toBeNull()
    expect(within(columns as HTMLElement).queryByText(/shared with|from S1713|via S1713/i)).toBeNull()
  })

  it("makes the line's badges reachable by keyboard", async () => {
    const user = userEvent.setup()
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION, THIRD] })
    await screen.findByText('Test Bill')
    const links = within(line()).getAllByRole('link')
    for (const a of links) expect(a.tabIndex).toBeGreaterThanOrEqual(0)
    const reached = new Set<Element>()
    for (let i = 0; i < 80 && reached.size < links.length; i++) {
      await user.tab()
      if (links.includes(document.activeElement as HTMLAnchorElement)) reached.add(document.activeElement!)
    }
    expect(reached.size).toBe(links.length)
  })

  it('reads as one sentence to a screen reader, its badges announced by their bill numbers', async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION, THIRD] })
    await screen.findByText('Test Bill')
    // One paragraph holds the whole sentence, not one block per badge.
    const paragraph = screen.getAllByRole('paragraph').filter(p => p.textContent?.startsWith('Comments, votes'))
    expect(paragraph).toHaveLength(1)
    expect(paragraph[0]).toHaveTextContent(SENTENCE_FOR('S1713 and H2000'))
    // Nothing in it is hidden from assistive technology.
    expect(paragraph[0].querySelector('[aria-hidden="true"]')).toBeNull()
    expect(within(paragraph[0]).getByRole('link', { name: 'S1713' })).toBeInTheDocument()
    expect(within(paragraph[0]).getByRole('link', { name: 'H2000' })).toBeInTheDocument()
  })

  it("draws the line's badges as mini badges, smaller than the header's", async () => {
    renderBillDetail({ ...GROUPED, ...NO_COMMENTS, groupBills: [THIS, COMPANION] })
    await screen.findByText('Test Bill')
    const inLine = within(line()).getByRole('link', { name: 'S1713' })
    const inHeader = within(screen.getByTestId('grouped-with-line')).getByRole('link', { name: 'S1713' })
    // The same mini badge as the header's "Grouped with" line: same size, same navy fill.
    expect(parseFloat(inLine.style.fontSize)).toBe(parseFloat(inHeader.style.fontSize))
    expect(inLine.style.background).toBe(inHeader.style.background)
  })
})

// A comment posted on a companion names the bill it was posted on with that
// bill's mini navy badge after the commenter's name. Queries are scoped to the
// comment's own header: the page's header and shares line link to the companion too.
describe('a comment posted on a companion', () => {
  const GROUP = { ...GROUPED, groupBills: [THIS, COMPANION, THIRD] }
  const POSTED_ON = 'This comment was posted on S1713, a companion bill in this group.'
  const commentEl = (id: string) => document.getElementById(`comment-${id}`)!
  const badgeIn = (id: string) => within(commentEl(id)).getByRole('link', { name: 'S1713' })
  // The bubble the badge shows on hover or focus is aria-hidden; its screen reader copy is not.
  const visibleBubbles = (text: string) =>
    screen.queryAllByText(text).filter(el => el.getAttribute('aria-hidden') === 'true')

  it("shows the companion's mini navy badge, linking to its canonical bill page", async () => {
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    const badge = badgeIn('c2')
    expect(badge).toHaveAttribute('href', '/NJ/2025-2026/S1713')
    expect(within(commentEl('c2')).getAllByRole('link')).toHaveLength(1)
    // Navy fill and mini size, the same as the shares line's.
    const inLine = within(screen.getByTestId('group-shares-line')).getByRole('link', { name: 'S1713' })
    expect(badge.style.background).toBe(inLine.style.background)
    expect(parseFloat(badge.style.fontSize)).toBe(parseFloat(inLine.style.fontSize))
    const pageBadge = within(screen.getByTestId('bill-header-badge')).getByText('A190').closest('span')!
    expect(parseFloat(badge.style.fontSize)).toBeLessThan(parseFloat(pageBadge.style.fontSize))
  })

  it("puts the badge after the commenter's name, inside the comment header", async () => {
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    const name = within(commentEl('c2')).getByText('Ben', { exact: false })
    expect(name.compareDocumentPosition(badgeIn('c2')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(badgeIn('c2').compareDocumentPosition(within(commentEl('c2')).getByText('c2 text')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says the comment was posted on the companion when the pointer hovers the badge, and drops it when the pointer leaves', async () => {
    const user = userEvent.setup()
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    expect(visibleBubbles(POSTED_ON)).toHaveLength(0)
    await user.hover(badgeIn('c2'))
    expect(visibleBubbles(POSTED_ON)).toHaveLength(1)
    await user.unhover(badgeIn('c2'))
    expect(visibleBubbles(POSTED_ON)).toHaveLength(0)
  })

  it('says the comment was posted on the companion when the badge takes keyboard focus, and drops it when focus leaves', async () => {
    const user = userEvent.setup()
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    const badge = badgeIn('c2')
    expect(visibleBubbles(POSTED_ON)).toHaveLength(0)
    for (let i = 0; i < 80 && document.activeElement !== badge; i++) await user.tab()
    expect(document.activeElement).toBe(badge)
    expect(visibleBubbles(POSTED_ON)).toHaveLength(1)
    await user.tab()
    expect(visibleBubbles(POSTED_ON)).toHaveLength(0)
  })

  it('gives a screen reader the same sentence as the badge\'s description, its name staying the bill number', async () => {
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    expect(badgeIn('c2')).toHaveAccessibleDescription(POSTED_ON)
  })

  // The bubble is position:fixed and jsdom has no layout, so placement reads from its transform: a bubble
  // above its badge is lifted by its own height, and one below it is not.
  const opensAbove = (bubble: HTMLElement) => bubble.style.transform.includes('translateY(calc(-100%')
  // The one visible bubble, found by what it is rather than what it says.
  const theBubble = () => {
    const found = Array.from(document.body.children).filter(el => el instanceof HTMLElement && el.tagName === 'SPAN' && el.getAttribute('aria-hidden') === 'true')
    expect(found).toHaveLength(1)
    return found[0] as HTMLElement
  }

  it('opens the bubble above the badge, not below it', async () => {
    const user = userEvent.setup()
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    await user.hover(badgeIn('c2'))
    expect(opensAbove(theBubble())).toBe(true)
  })

  it('opens the bubble above the badge for a keyboard user too', async () => {
    const user = userEvent.setup()
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    const badge = badgeIn('c2')
    for (let i = 0; i < 80 && document.activeElement !== badge; i++) await user.tab()
    expect(opensAbove(theBubble())).toBe(true)
  })

  it('no longer says "Posted on" anywhere, on the bubble or in the description', async () => {
    const user = userEvent.setup()
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    await user.hover(badgeIn('c2'))
    expect(screen.queryAllByText(/^Posted on /)).toHaveLength(0)
  })

  it('keeps the screen reader description equal to the visible bubble text', async () => {
    const user = userEvent.setup()
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    await user.hover(badgeIn('c2'))
    const bubble = theBubble()
    const hidden = document.getElementById(badgeIn('c2').getAttribute('aria-describedby')!)
    expect(hidden).not.toBeNull()
    expect(hidden!.textContent).toBe(bubble.textContent)
    expect(badgeIn('c2')).toHaveAccessibleDescription(bubble.textContent!)
    expect(bubble.textContent).toBe(POSTED_ON)
  })

  it('names the companion each comment was posted on in a group of three or more, above its badge', async () => {
    const user = userEvent.setup()
    renderBillDetail({
      ...GROUP,
      comments: [
        comment('c2', 'b1713', 'S1713', '2026-10-10 13:00:00', 'Ben'),
        comment('c4', 'c2000', 'H2000', '2026-10-10 14:00:00', 'Cy'),
      ],
      commentsTotal: 2,
      groupingEvents: [],
    })
    await screen.findByText('c4 text')
    const onH2000 = 'This comment was posted on H2000, a companion bill in this group.'
    const h2000 = within(commentEl('c4')).getByRole('link', { name: 'H2000' })
    expect(h2000).toHaveAccessibleDescription(onH2000)
    expect(badgeIn('c2')).toHaveAccessibleDescription(POSTED_ON)
    await user.hover(h2000)
    expect(visibleBubbles(onH2000)).toHaveLength(1)
    expect(visibleBubbles(POSTED_ON)).toHaveLength(0)
    expect(opensAbove(theBubble())).toBe(true)
  })

  it('says nothing about a companion on comments posted on the page\'s own bill', async () => {
    const user = userEvent.setup()
    renderBillDetail({ ...GROUP, comments: [comment('c1', '42', 'A190', '2026-10-10 12:00:00', 'Ann')], commentsTotal: 1, groupingEvents: [] })
    await screen.findByText('c1 text')
    await user.hover(within(commentEl('c1')).getByText('Ann'))
    expect(screen.queryByText(/a companion bill in this group/)).toBeNull()
  })

  it('says nothing about a companion on a bill in no group', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS], groupingEvents: [], comments: [comment('c1', '42', 'A190', '2026-10-10 12:00:00', 'Ann')], commentsTotal: 1 })
    await screen.findByText('c1 text')
    expect(screen.queryByText(/a companion bill in this group/)).toBeNull()
  })

  it('names the bill each companion comment was posted on, and no other', async () => {
    renderBillDetail({
      ...GROUP,
      comments: [
        comment('c1', '42', 'A190', '2026-10-10 12:00:00', 'Ann'),
        comment('c2', 'b1713', 'S1713', '2026-10-10 13:00:00', 'Ben'),
        comment('c4', 'c2000', 'H2000', '2026-10-10 14:00:00', 'Cy'),
      ],
      commentsTotal: 3,
    })
    await screen.findByText('c4 text')
    expect(within(commentEl('c4')).getByRole('link', { name: 'H2000' })).toHaveAttribute('href', '/NJ/2026/H2000')
    expect(within(commentEl('c4')).queryByRole('link', { name: 'S1713' })).toBeNull()
    expect(within(commentEl('c2')).getByRole('link', { name: 'S1713' })).toHaveAttribute('href', '/NJ/2025-2026/S1713')
    expect(within(commentEl('c2')).queryByRole('link', { name: 'H2000' })).toBeNull()
  })

  it('shows a badge on every comment the commenter posts on the companion, each its own', async () => {
    // Comments are a flat list, with no reply to a comment: a follow-up is another comment, and gets its own badge.
    renderBillDetail({
      ...GROUP,
      comments: [
        comment('c2', 'b1713', 'S1713', '2026-10-10 13:00:00', 'Ben'),
        comment('c5', 'b1713', 'S1713', '2026-10-10 14:00:00', 'Ann'),
      ],
      commentsTotal: 2,
      groupingEvents: [],
    })
    await screen.findByText('c5 text')
    expect(badgeIn('c2')).toHaveAttribute('href', '/NJ/2025-2026/S1713')
    expect(badgeIn('c5')).toHaveAttribute('href', '/NJ/2025-2026/S1713')
  })

  it('shows no badge on a comment posted on the page\'s own bill', async () => {
    renderBillDetail(GROUP)
    await screen.findByText('c1 text')
    for (const id of ['c1', 'c3']) {
      expect(within(commentEl(id)).queryByRole('link')).toBeNull()
      expect(commentEl(id).textContent).not.toContain('A190')
    }
  })

  it('shows no badge on a comment just posted here, which carries no bill', async () => {
    renderBillDetail({
      ...GROUP,
      comments: [{ id: 'c6', userId: 'u-Ann', userName: 'Ann', userTitle: null, content: '<p>c6 text</p>', createdAt: '2026-10-12 12:00:00', reactions: [] }],
      commentsTotal: 1,
      groupingEvents: [],
    })
    await screen.findByText('c6 text')
    expect(within(commentEl('c6')).queryByRole('link')).toBeNull()
  })

  it('shows no badge on any comment of a bill in no group', async () => {
    renderBillDetail({ ...GROUPED, groupBills: [THIS], groupingEvents: [], comments: [comment('c1', '42', 'A190', '2026-10-10 12:00:00', 'Ann')], commentsTotal: 1 })
    await screen.findByText('c1 text')
    expect(within(commentEl('c1')).queryByRole('link')).toBeNull()
  })

  it('no longer renders the gray tag: the number shows once in the header, as the badge, with no title tooltip', async () => {
    renderBillDetail(GROUP)
    await screen.findByText('c2 text')
    expect(within(commentEl('c2')).getAllByText('S1713')).toHaveLength(1)
    expect(within(commentEl('c2')).getByText('S1713').closest('a')).not.toBeNull()
    expect(document.querySelector('[title^="Posted on"]')).toBeNull()
  })

  it('links a companion with no session slug to /bills/:id', async () => {
    renderBillDetail({ ...GROUP, groupBills: [THIS, { ...COMPANION, sessionSlug: '' }] })
    await screen.findByText('c2 text')
    expect(badgeIn('c2')).toHaveAttribute('href', '/bills/b1713')
  })

  it('still names the bill on a comment from a bill since split off, linking to it by id', async () => {
    // A split gives the bill back its own discussion, so a page loaded after the split lists none of its comments.
    // One loaded before it (open in another tab) can still carry them, with the bill gone from groupBills.
    // The comment was posted on that bill, so the badge keeps saying so; with no state or session to build
    // the canonical URL from, it links to /bills/:id, which redirects to the canonical page.
    renderBillDetail({ ...GROUP, groupBills: [THIS, THIRD] })
    await screen.findByText('c2 text')
    expect(badgeIn('c2')).toHaveAttribute('href', '/bills/b1713')
    expect(within(commentEl('c2')).getAllByText('S1713')).toHaveLength(1)
  })

  it('names the bill on a comment from a companion when the response carries no group bills at all', async () => {
    renderBillDetail({ ...GROUPED, groupBills: undefined })
    await screen.findByText('c2 text')
    expect(badgeIn('c2')).toHaveAttribute('href', '/bills/b1713')
  })

  it('shows no badge when the comment names no bill number to show', async () => {
    renderBillDetail({
      ...GROUP,
      comments: [{ ...comment('c7', 'b9999', 'S1713', '2026-10-10 13:00:00', 'Ben'), billNumber: null }],
      commentsTotal: 1,
      groupingEvents: [],
    })
    await screen.findByText('c7 text')
    expect(within(commentEl('c7')).queryByRole('link')).toBeNull()
  })
})

// Where the shares line sits. It describes the comments and position boxes below it, so it lines up with
// the "Comments" heading in the comments card and sits closer to those boxes than to the bill card above.
// jsdom has no layout, so both read from the computed styles that place them.
describe('where the line saying what a companion group shares sits', () => {
  const DOCUMENT = {
    supplementId: 1, typeId: 1, type: 'Fiscal Note', date: null, dateResolved: null, dateInferred: false,
    title: 'Fiscal note', description: 'A fiscal note', mime: null, url: 'https://example.com/note', stateLink: null,
  }
  const WITH_SECTIONS = { ...GROUPED, comments: [], commentsTotal: 0, groupingEvents: [], supplements: [DOCUMENT] }
  const line = () => screen.getByTestId('group-shares-line')
  const px = (value: string) => parseFloat(value) || 0
  const own = (el: Element) => {
    const s = getComputedStyle(el)
    return px(s.marginLeft) + px(s.borderLeftWidth) + px(s.paddingLeft)
  }
  // Pixels from the page's left edge to where the comments heading's text starts: every margin, border, and
  // padding between the line's own container and the heading. jsdom drops the card's border shorthand (its
  // color is a CSS variable), so the border's width comes from the shared card style.
  const headingOffset = (heading: HTMLElement, card: HTMLElement, page: HTMLElement) => {
    let x = 0
    for (let n: HTMLElement | null = heading; n && n !== card; n = n.parentElement) x += own(n)
    x += parseFloat(CARD.border) + px(getComputedStyle(card).paddingLeft)
    for (let n: HTMLElement | null = card.parentElement; n && n !== page; n = n.parentElement) x += own(n)
    return x
  }
  const commentsHeading = () => {
    const card = document.getElementById('section-comments') as HTMLElement
    return { card, heading: within(card).getByText(/^Comments/) }
  }

  it('lines up with the Comments heading, for a group of two', async () => {
    renderBillDetail({ ...WITH_SECTIONS, groupBills: [THIS, COMPANION] })
    await screen.findByText('Documents')
    const { card, heading } = commentsHeading()
    const offset = headingOffset(heading, card, line().parentElement as HTMLElement)
    expect(offset).toBeGreaterThan(0)
    expect(own(line())).toBe(offset)
  })

  it('lines up the same way for a group of three or more', async () => {
    renderBillDetail({ ...WITH_SECTIONS, groupBills: [THIS, COMPANION, THIRD] })
    await screen.findByText('Documents')
    const { card, heading } = commentsHeading()
    expect(own(line())).toBe(headingOffset(heading, card, line().parentElement as HTMLElement))
  })

  it('sits closer to the comments and position boxes below it than to the bill card above it', async () => {
    renderBillDetail({ ...WITH_SECTIONS, groupBills: [THIS, COMPANION] })
    await screen.findByText('Documents')
    const columns = document.querySelector('.bill-detail-columns') as HTMLElement
    // The columns' top padding adds to the line's bottom margin, and the card has no bottom margin.
    const above = px(getComputedStyle(line()).marginTop) + px(getComputedStyle(line().previousElementSibling!).marginBottom)
    const below = px(getComputedStyle(line()).marginBottom) + px(getComputedStyle(columns).paddingTop)
    expect(below).toBeGreaterThanOrEqual(0)
    expect(below).toBeLessThan(above)
  })

  it('stays a single muted line inside the page, with the sentence unchanged', async () => {
    renderBillDetail({ ...WITH_SECTIONS, groupBills: [THIS, COMPANION] })
    await screen.findByText('Documents')
    expect(line()).toHaveTextContent('Comments, votes, and association position are shared with S1713.')
    expect(line().tagName).toBe('P')
  })

  it('draws no line for a bill in no group, leaving the card and the columns as they were', async () => {
    renderBillDetail({ ...WITH_SECTIONS, groupBills: [THIS] })
    await screen.findByText('Documents')
    expect(screen.queryByTestId('group-shares-line')).toBeNull()
    expect(getComputedStyle(document.querySelector('.bill-detail-columns')!).paddingTop).toBe('24px')
  })
})

// The commenter's name opens a roles bubble on hover; the badge beside it has its own.
describe("a companion comment's badge and the commenter's roles bubble", () => {
  const POSTED_ON = 'This comment was posted on S1713, a companion bill in this group.'
  const COMMENTS = {
    ...GROUPED,
    groupBills: [THIS, COMPANION],
    comments: [comment('c2', 'b1713', 'S1713', '2026-10-10 13:00:00', 'Ben')],
    commentsTotal: 1,
    groupingEvents: [],
  }
  const renderWithRoles = () => {
    const bill = { ...BILL, ...COMMENTS }
    routerMock.loaderData = bill
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/42') return bill as never
      if (path === '/config') return { ...CONFIG } as never
      if (path === '/config/custom-fields') return [] as never
      if (path === '/roles') return [] as never
      if (path === '/users') return [{ id: 'u-Ben', name: 'Ben', email: 'ben@example.com', title: null, roles: [{ id: 'r1', name: 'Policy lead' }] }] as never
      return {} as never
    })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
  }
  const bubbles = (text: string) => screen.queryAllByText(text).filter(el => el.getAttribute('aria-hidden') === 'true')

  it('shows only the companion sentence when the pointer hovers the badge, not the commenter\'s roles', async () => {
    const user = userEvent.setup()
    renderWithRoles()
    await screen.findByText('c2 text')
    await user.hover(within(document.getElementById('comment-c2')!).getByRole('link', { name: 'S1713' }))
    expect(bubbles(POSTED_ON)).toHaveLength(1)
    expect(screen.queryByText('Roles')).toBeNull()
    expect(screen.queryByText('Policy lead')).toBeNull()
  })

  it('still shows the roles, and not the companion sentence, when the pointer hovers the name', async () => {
    const user = userEvent.setup()
    renderWithRoles()
    await screen.findByText('c2 text')
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/users'))
    await user.hover(within(document.getElementById('comment-c2')!).getByText('Ben'))
    expect(await screen.findByText('Policy lead')).toBeInTheDocument()
    expect(bubbles(POSTED_ON)).toHaveLength(0)
  })

  it('closes the companion bubble when Escape is pressed on the focused badge', async () => {
    const user = userEvent.setup()
    renderWithRoles()
    await screen.findByText('c2 text')
    const badge = within(document.getElementById('comment-c2')!).getByRole('link', { name: 'S1713' })
    for (let i = 0; i < 80 && document.activeElement !== badge; i++) await user.tab()
    expect(bubbles(POSTED_ON)).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(bubbles(POSTED_ON)).toHaveLength(0)
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
      'link' + 'Grouped with S1713 as identical bills on October 14. Earlier comments on S1713 now appear here.',
    ])
  })

  it('renders an event from an older server that sends no commentBills as an automatic line with nothing to explain', async () => {
    const { commentBills: _omit, ...old } = grouped()
    renderBillDetail({ ...GROUPED, groupingEvents: [old] })
    await screen.findByText('c3 text')
    expect(lines()).toEqual([])
  })
})
