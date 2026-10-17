import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  const spy = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG, ...config } as never
    if (path === '/config/custom-fields') return customFields as never
    if (path === '/roles' || path === '/users') return [] as never
    if (path === '/bills/42/comments' && init?.method === 'POST') return { id: 'posted', content: '<p>hi</p>', createdAt: '2026-10-20 12:00:00' } as never
    if (path === '/bills/42/mute') return { muted: init?.method === 'PUT' } as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  return spy
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})

const comment = (id: string, billId: string, billNumber: string, createdAt: string, userName: string) => ({
  id, billId, billNumber, userId: `u-${userName}`, userName, userSubtitle: null,
  content: `<p>${id} text</p>`, createdAt, reactions: [],
})

// An activity change as the route serves it: a priority change by David Park on
// this bill (42), oldest first by `createdAt`.
const change = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id, createdAt, actorId: 'u-david', actorName: 'David Park', billId: '42', billNumber: 'HB 1',
  field: 'priority', label: 'priority', old: 'medium', new: 'high', ...over,
})
const ann = { actorId: 'u-ann', actorName: 'Ann' }

const C1 = comment('c1', '42', 'HB 1', '2026-10-10 12:00:00', 'Ann')
const C2 = comment('c2', '42', 'HB 1', '2026-10-12 12:00:00', 'Ben')
const C3 = comment('c3', '42', 'HB 1', '2026-10-14 12:00:00', 'Ann')

const thread = () => document.getElementById('section-comments') as HTMLElement
const heading = () => within(thread()).getAllByText(/^Comments/)[0]
const notes = () => within(thread()).queryAllByRole('note').map(n => n.textContent)
// The thread's comments and activity in page order, by what each says.
const order = () => Array.from(thread().querySelectorAll('[id^="comment-"], [role="note"], button[aria-expanded]'))
  .map(el => el.id
    ? el.id.replace('comment-', '')
    : el.getAttribute('role') === 'note'
      ? (el.textContent ?? '').replace(/^[a-z_0-9]+/, '')
      : `fold:${(el.textContent ?? '').replace(/^[a-z_0-9]+/, '').replace(/[▸▾]/g, '').trim()}`)
const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('the heading of the comments card', () => {
  it('reads "Comments and activity" once the thread has a line of activity', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('c1 text')
    expect(heading()).toHaveTextContent(/^Comments and activity/)
  })

  it('reads "Comments and activity" for a thread with only a grouping line, which is activity too', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, groupingEvents: [{ id: 'g', type: 'grouped', createdAt: '2026-10-11 12:00:00', actorName: 'Ada', with: [{ billId: 'b1713', billNumber: 'S1713' }], commentBills: [], replaced: [] }] })
    await screen.findByText('c1 text')
    expect(heading()).toHaveTextContent(/^Comments and activity/)
  })

  it('stays "Comments" with only comments, or when every grouping line would show nothing', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, fieldEvents: [], groupingEvents: [{ id: 'g', type: 'grouped', createdAt: '2026-10-11 12:00:00', actorName: null, with: [{ billId: 'b1713', billNumber: 'S1713' }], commentBills: [], replaced: [] }] })
    await screen.findByText('c1 text')
    expect(heading()).toHaveTextContent(/^Comments/)
    expect(heading()).not.toHaveTextContent('and activity')
  })

  it('stays "Comments" when the server sends no fieldEvents at all, as an older one does', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1 })
    await screen.findByText('c1 text')
    expect(heading()).not.toHaveTextContent('and activity')
  })

  it('counts only comments in the badge, however much activity there is', async () => {
    renderBillDetail({ comments: [C1, C2], commentsTotal: 2, fieldEvents: [change('e1', '2026-10-11 12:00:00'), change('e2', '2026-10-11 13:00:00', ann), change('e3', '2026-10-13 12:00:00')] })
    await screen.findByText('c1 text')
    expect(heading()).toHaveTextContent('Comments and activity2')
  })

  it('shows no count for a thread of activity alone', async () => {
    renderBillDetail({ comments: [], commentsTotal: 0, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('Test Bill')
    expect(heading()).toHaveTextContent(/^Comments and activity$/)
  })
})

describe('the thread of a bill with only comments, only activity, or both', () => {
  it('shows only comments, and no line, when there is no activity', async () => {
    renderBillDetail({ comments: [C1, C2], commentsTotal: 2 })
    await screen.findByText('c2 text')
    expect(notes()).toEqual([])
    expect(order()).toEqual(['c1', 'c2'])
  })

  it('shows the activity lines alone, oldest first, when there are no comments', async () => {
    renderBillDetail({ comments: [], commentsTotal: 0, fieldEvents: [
      change('e1', '2026-10-11 12:00:00', { old: null, new: 'medium' }),
      change('e2', '2026-10-13 12:00:00', { ...ann, field: 'position', label: 'position', old: null, new: 'Support' }),
    ] })
    await screen.findByText('Test Bill')
    expect(notes()).toEqual([
      'flag' + 'David Park set priority to Medium · Oct 11',
      'thumbs_up_down' + 'Ann set the association position to Support · Oct 13',
    ])
    expect(document.querySelectorAll('[id^="comment-"]')).toHaveLength(0)
    // The composer is still there.
    expect(screen.getByRole('button', { name: 'Post' })).toBeInTheDocument()
  })

  it('sets each line between the comments posted before and after it, and a line after the last comment at the end', async () => {
    renderBillDetail({ comments: [C1, C2, C3], commentsTotal: 3, fieldEvents: [
      change('e1', '2026-10-09 12:00:00', { old: null, new: 'low' }),
      change('e2', '2026-10-11 12:00:00', { old: 'low', new: 'medium', ...ann }),
      change('e3', '2026-10-15 12:00:00', { field: 'position', label: 'position', old: null, new: 'Oppose' }),
    ] })
    await screen.findByText('c3 text')
    expect(order()).toEqual([
      'David Park set priority to Low · Oct 9',
      'c1',
      'Ann changed priority from Low to Medium · Oct 11',
      'c2',
      'c3',
      'David Park set the association position to Oppose · Oct 15',
    ])
  })

  it('weaves grouping lines in with the changes by time', async () => {
    renderBillDetail({ comments: [C1, C2], commentsTotal: 2,
      groupingEvents: [{ id: 'g', type: 'grouped', createdAt: '2026-10-11 12:00:00', actorName: 'Ada', with: [{ billId: 'b1713', billNumber: 'S1713' }], commentBills: [], replaced: [] }],
      fieldEvents: [change('e1', '2026-10-11 10:00:00', ann), change('e2', '2026-10-11 14:00:00', ann)],
    })
    await screen.findByText('c2 text')
    expect(order()).toEqual([
      'c1',
      'Ann changed priority from Medium to High · Oct 11',
      'Ada grouped this bill with S1713 on October 11.',
      'Ann changed priority from Medium to High · Oct 11',
      'c2',
    ])
  })

  it('words the position with the instance\'s noun, as the position card does', async () => {
    renderBillDetail({ comments: [], commentsTotal: 0, fieldEvents: [change('e1', '2026-10-11 12:00:00', { field: 'position', label: 'position', old: null, new: 'Support' })] }, { orgNoun: 'alliance' })
    await screen.findByText('Test Bill')
    expect(screen.getByText(/set the alliance position to Support/)).toBeInTheDocument()
  })

  it('words a custom field by the name it had and FloorVote\'s tags by FloorVote', async () => {
    renderBillDetail({ comments: [], commentsTotal: 0, fieldEvents: [
      change('e1', '2026-10-11 12:00:00', { field: 'customField', fieldId: 'cf1', label: 'Lead staffer', old: null, new: 'Policy team', fieldType: 'text' }),
      change('e2', '2026-10-12 12:00:00', { actorId: null, actorName: null, field: 'tags', label: 'tags', old: [], new: ['Energy', 'Labor'] }),
    ] })
    await screen.findByText('Test Bill')
    expect(notes()).toEqual([
      'edit_note' + 'David Park set Lead staffer to "Policy team" · Oct 11',
      'list' + 'FloorVote added the tags Energy and Labor · Oct 12',
    ])
  })

  it('shows the same lines to a member as to an admin', async () => {
    authState.role = 'member'
    renderBillDetail({ comments: [C1], commentsTotal: 1, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('c1 text')
    const asMember = notes()
    cleanup()
    authState.role = 'admin'
    renderBillDetail({ comments: [C1], commentsTotal: 1, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('c1 text')
    expect(asMember).toEqual(['flag' + 'David Park changed priority from Medium to High · Oct 11'])
    expect(notes()).toEqual(asMember)
  })

  it('shows neither lines nor a count in an empty thread, which still offers the composer', async () => {
    renderBillDetail({ comments: [], commentsTotal: 0, fieldEvents: [] })
    await screen.findByText('Test Bill')
    expect(heading()).toHaveTextContent(/^Comments$/)
    expect(notes()).toEqual([])
    expect(screen.getByRole('button', { name: 'Post' })).toBeInTheDocument()
  })
})

describe('folding a run of changes in the thread', () => {
  const run = [
    change('e1', '2026-10-11 10:00:00', { old: null, new: 'low' }),
    change('e2', '2026-10-11 11:00:00', { old: 'low', new: 'medium' }),
    change('e3', '2026-10-11 12:00:00', { old: 'medium', new: 'high' }),
  ]
  const foldButton = () => screen.getByRole('button', { name: '3 changes by David Park' })

  it('folds three changes by one person between two comments into one closed line', async () => {
    renderBillDetail({ comments: [C1, C2], commentsTotal: 2, fieldEvents: run })
    await screen.findByText('c2 text')
    expect(foldButton()).toHaveAttribute('aria-expanded', 'false')
    expect(notes()).toEqual([])
    expect(follows(document.getElementById('comment-c1')!, foldButton())).toBe(true)
    expect(follows(foldButton(), document.getElementById('comment-c2')!)).toBe(true)
  })

  it('opens in place, between the same two comments, and closes again', async () => {
    const user = userEvent.setup()
    renderBillDetail({ comments: [C1, C2], commentsTotal: 2, fieldEvents: run })
    await screen.findByText('c2 text')
    await user.click(foldButton())
    expect(order()).toEqual([
      'c1',
      'fold:3 changes by David Park',
      'David Park set priority to Low · Oct 11',
      'David Park changed priority from Low to Medium · Oct 11',
      'David Park changed priority from Medium to High · Oct 11',
      'c2',
    ])
    await user.click(foldButton())
    expect(notes()).toEqual([])
  })

  it('folds a run by FloorVote and a run by a person apart', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, fieldEvents: [
      change('r1', '2026-10-11 10:00:00', { actorId: null, actorName: null, field: 'tags', label: 'tags', old: [], new: ['Energy'] }),
      change('r2', '2026-10-11 11:00:00', { actorId: null, actorName: null, field: 'tags', label: 'tags', old: ['Energy'], new: ['Energy', 'Labor'] }),
      change('a1', '2026-10-11 12:00:00', ann), change('a2', '2026-10-11 13:00:00', ann),
    ] })
    await screen.findByText('Test Bill')
    expect(screen.getByRole('button', { name: '2 changes by FloorVote' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 changes by Ann' })).toBeInTheDocument()
  })

  it('does not fold changes a comment sits between', async () => {
    renderBillDetail({ comments: [C1, C2], commentsTotal: 2, fieldEvents: [change('e1', '2026-10-09 12:00:00'), change('e2', '2026-10-11 12:00:00')] })
    await screen.findByText('c2 text')
    expect(screen.queryByRole('button', { name: /changes by/ })).toBeNull()
    expect(notes()).toHaveLength(2)
  })

  it('folds the changes made on a companion in with the bill\'s, each line still marked with its bill when opened', async () => {
    const user = userEvent.setup()
    renderBillDetail({ comments: [C1], commentsTotal: 1,
      groupBills: [{ billId: '42', billNumber: 'HB 1', state: 'NJ', sessionSlug: '2026' }, { billId: 'b1713', billNumber: 'S1713', state: 'NJ', sessionSlug: '2025-2026' }],
      fieldEvents: [change('e1', '2026-10-11 10:00:00'), change('e2', '2026-10-11 11:00:00', { billId: 'b1713', billNumber: 'S1713' })] })
    await screen.findByText('Test Bill')
    await user.click(screen.getByRole('button', { name: '2 changes by David Park' }))
    const [own, other] = within(thread()).getAllByRole('note')
    expect(within(own).queryByRole('link')).toBeNull()
    expect(within(other).getByRole('link', { name: 'S1713' })).toHaveAttribute('href', '/NJ/2025-2026/S1713')
  })

  it('follows a deleted comment: its two sides fold together once it is gone', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderBillDetail({ comments: [C1, C2, C3], commentsTotal: 3, fieldEvents: [change('e1', '2026-10-11 12:00:00'), change('e2', '2026-10-13 12:00:00')] })
    await screen.findByText('c3 text')
    expect(screen.queryByRole('button', { name: /changes by/ })).toBeNull()
    expect(notes()).toHaveLength(2)
    await user.click(within(document.getElementById('comment-c2')!).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(document.getElementById('comment-c2')).toBeNull())
    expect(await screen.findByRole('button', { name: '2 changes by David Park' })).toBeInTheDocument()
    expect(heading()).toHaveTextContent('Comments and activity2')
  })

  it('keeps the activity when the last comment is deleted, now at the end of the thread', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderBillDetail({ comments: [C1], commentsTotal: 1, fieldEvents: [change('e1', '2026-10-09 12:00:00')] })
    await screen.findByText('c1 text')
    await user.click(within(document.getElementById('comment-c1')!).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(document.getElementById('comment-c1')).toBeNull())
    expect(notes()).toEqual(['flag' + 'David Park changed priority from Medium to High · Oct 9'])
    expect(heading()).toHaveTextContent(/^Comments and activity$/)
  })

  it('puts a comment posted now after the activity before it', async () => {
    const user = userEvent.setup()
    renderBillDetail({ comments: [C1], commentsTotal: 1, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('c1 text')
    await user.click(screen.getByRole('button', { name: 'Post' }))
    await screen.findByText('hi')
    expect(order()).toEqual(['c1', 'David Park changed priority from Medium to High · Oct 11', 'posted'])
  })
})

describe('activity on a companion in the group', () => {
  const GROUP = [
    { billId: '42', billNumber: 'HB 1', state: 'NJ', sessionSlug: '2026' },
    { billId: 'b1713', billNumber: 'S1713', state: 'NJ', sessionSlug: '2025-2026' },
  ]
  const MADE_ON = 'This change was made on S1713, a companion bill in this group.'
  const visibleBubbles = (text: string) => screen.queryAllByText(text).filter(el => el.getAttribute('aria-hidden') === 'true')
  const onCompanion = change('e2', '2026-10-11 12:00:00', { billId: 'b1713', billNumber: 'S1713', field: 'position', label: 'position', old: null, new: 'Support', actorName: 'Ann', actorId: 'u-ann' })

  it("labels a change made on the companion with its badge, linking to its canonical page, and not one made on this bill", async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, groupBills: GROUP, fieldEvents: [change('e1', '2026-10-10 13:00:00'), onCompanion] })
    await screen.findByText('c1 text')
    const [own, other] = within(thread()).getAllByRole('note')
    expect(within(own).queryByRole('link')).toBeNull()
    expect(within(other).getByRole('link', { name: 'S1713' })).toHaveAttribute('href', '/NJ/2025-2026/S1713')
  })

  it('names the bill the change was made on when the pointer hovers the badge, and drops it when the pointer leaves', async () => {
    const user = userEvent.setup()
    renderBillDetail({ comments: [C1], commentsTotal: 1, groupBills: GROUP, fieldEvents: [onCompanion] })
    await screen.findByText('c1 text')
    const badge = within(thread()).getByRole('link', { name: 'S1713' })
    expect(visibleBubbles(MADE_ON)).toHaveLength(0)
    await user.hover(badge)
    expect(visibleBubbles(MADE_ON)).toHaveLength(1)
    await user.unhover(badge)
    expect(visibleBubbles(MADE_ON)).toHaveLength(0)
  })

  it('names it for a keyboard user too, and gives a screen reader the same sentence as the badge\'s description', async () => {
    const user = userEvent.setup()
    renderBillDetail({ comments: [C1], commentsTotal: 1, groupBills: GROUP, fieldEvents: [onCompanion] })
    await screen.findByText('c1 text')
    const badge = within(thread()).getByRole('link', { name: 'S1713' })
    for (let i = 0; i < 80 && document.activeElement !== badge; i++) await user.tab()
    expect(document.activeElement).toBe(badge)
    expect(visibleBubbles(MADE_ON)).toHaveLength(1)
    expect(badge).toHaveAccessibleDescription(MADE_ON)
  })

  it('still labels a change from a bill since split off, linking to it by id', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, groupBills: [GROUP[0]], fieldEvents: [onCompanion] })
    await screen.findByText('c1 text')
    expect(within(thread()).getByRole('link', { name: 'S1713' })).toHaveAttribute('href', '/bills/b1713')
  })

  it('labels a change made on the companion when the response carries no group bills at all', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, groupBills: undefined, fieldEvents: [onCompanion] })
    await screen.findByText('c1 text')
    expect(within(thread()).getByRole('link', { name: 'S1713' })).toBeInTheDocument()
  })

  it('leaves the comment badge on a companion comment as it was, beside activity lines', async () => {
    const user = userEvent.setup()
    renderBillDetail({ comments: [C1, comment('c2', 'b1713', 'S1713', '2026-10-12 12:00:00', 'Ben')], commentsTotal: 2, groupBills: GROUP, fieldEvents: [onCompanion] })
    await screen.findByText('c2 text')
    const badge = within(document.getElementById('comment-c2')!).getByRole('link', { name: 'S1713' })
    await user.hover(badge)
    expect(visibleBubbles('This comment was posted on S1713, a companion bill in this group.')).toHaveLength(1)
    expect(visibleBubbles(MADE_ON)).toHaveLength(0)
  })
})

describe('the mute control beside the new heading', () => {
  it('still sits at the right of the header, muting and unmuting as before, with activity in the thread', async () => {
    const user = userEvent.setup()
    const spy = renderBillDetail({ comments: [C1], commentsTotal: 1, commentsParticipant: true, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('c1 text')
    const mute = within(thread()).getByRole('button', { name: 'Mute comments' })
    expect(follows(heading(), mute)).toBe(true)
    await user.click(mute)
    expect(spy.mock.calls.filter(([p]) => p === '/bills/42/mute').map(([, i]) => (i as RequestInit).method)).toEqual(['PUT'])
    expect(await within(thread()).findByRole('button', { name: 'Unmute comments' })).toBeInTheDocument()
    expect(within(thread()).getByText(/mentions still reach you/i)).toBeInTheDocument()
    expect(heading()).toHaveTextContent('Comments and activity')
  })

  it('offers Mute to a participant in a thread of activity alone, as the heading is the only thing in it', async () => {
    renderBillDetail({ comments: [], commentsTotal: 0, commentsParticipant: true, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('Test Bill')
    expect(within(thread()).getByRole('button', { name: 'Mute comments' })).toBeInTheDocument()
  })

  it('offers no Mute to someone who is not a participant, however much activity there is', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, commentsParticipant: false, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('c1 text')
    expect(within(thread()).queryByRole('button', { name: /mute comments/i })).toBeNull()
  })
})

describe('reading the thread by keyboard and screen reader', () => {
  it('tabs from the mute button past the first comment\'s controls to the fold, then on to the next comment\'s, not into the fold\'s lines', async () => {
    const user = userEvent.setup()
    renderBillDetail({ comments: [C1, C2], commentsTotal: 2, commentsParticipant: true, fieldEvents: [
      change('e1', '2026-10-11 10:00:00'), change('e2', '2026-10-11 11:00:00'),
    ] })
    await screen.findByText('c2 text')
    const label = (el: Element | null) => el?.getAttribute('aria-label') ?? (el?.textContent ?? '').trim()
    const mute = within(thread()).getByRole('button', { name: 'Mute comments' })
    for (let i = 0; i < 200 && document.activeElement !== mute; i++) await user.tab()
    expect(mute).toHaveFocus()
    const seen: string[] = []
    for (let i = 0; i < 10 && !label(document.activeElement).startsWith('2 changes by'); i++) {
      await user.tab()
      seen.push(label(document.activeElement))
    }
    expect(seen.at(-1)).toMatch(/^2 changes by David Park/)
    // Everything on the way is the first comment's.
    expect(seen.slice(0, -1).length).toBeGreaterThan(0)
    for (const el of Array.from(thread().querySelectorAll('button'))) {
      if (document.getElementById('comment-c1')!.contains(el)) expect(follows(el, screen.getByRole('button', { name: /2 changes by/ }))).toBe(true)
    }
    await user.keyboard('{Enter}')
    expect(screen.getAllByRole('note')).toHaveLength(2)
    await user.tab()
    expect(document.getElementById('comment-c2')!.contains(document.activeElement)).toBe(true)
  })

  it('keeps an open fold\'s lines in the DOM right after its button, before the next comment', async () => {
    const user = userEvent.setup()
    renderBillDetail({ comments: [C1, C2], commentsTotal: 2, fieldEvents: [change('e1', '2026-10-11 10:00:00'), change('e2', '2026-10-11 11:00:00')] })
    await screen.findByText('c2 text')
    const button = screen.getByRole('button', { name: '2 changes by David Park' })
    await user.click(button)
    const list = screen.getByRole('list')
    expect(follows(button, list)).toBe(true)
    expect(follows(list, document.getElementById('comment-c2')!)).toBe(true)
    expect(follows(document.getElementById('comment-c1')!, button)).toBe(true)
  })

  it('announces a lone change as a note, in the thread\'s order, and not as a control', async () => {
    renderBillDetail({ comments: [C1], commentsTotal: 1, fieldEvents: [change('e1', '2026-10-11 12:00:00')] })
    await screen.findByText('c1 text')
    const [line] = within(thread()).getAllByRole('note')
    expect(line.querySelector('button, a')).toBeNull()
    expect(follows(document.getElementById('comment-c1')!, line)).toBe(true)
  })
})
