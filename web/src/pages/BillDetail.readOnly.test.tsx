import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// ── Scaffolding copied from BillDetail.test.tsx ────────────────────────────────

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
  useNotifications: () => ({ unreadCount: 0, refresh: vi.fn() }),
}))

vi.mock('../hooks/usePolling', () => ({
  usePolling: () => {},
}))

vi.mock('../hooks/usePageTitle', () => ({
  usePageTitle: () => {},
}))

// ── Fixtures ────────────────────────────────────────────────────────────────

const OWN_COMMENT = {
  id: 'c1',
  userId: 'u1',
  userName: 'Alice',
  userSubtitle: null,
  content: 'My own comment',
  createdAt: '2025-01-02 00:00:00',
  reactions: [{ emoji: '👍', count: 1, userReacted: false, reactors: [{ name: 'Bob', subtitle: null }] }],
}

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
  customFieldValues: {
    f1: { value: 'Some notes', setBy: 'Admin', updatedAt: '2025-01-01 00:00:00' },
    f2: { value: '1', setBy: 'Admin', updatedAt: '2025-01-01 00:00:00' },
    f3: { value: 'Option A', setBy: 'Admin', updatedAt: '2025-01-01 00:00:00' },
    f4: { value: '2025-06-01', setBy: 'Admin', updatedAt: '2025-01-01 00:00:00' },
  },
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
  comments: [OWN_COMMENT],
  commentsTotal: 1,
}

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}

const CUSTOM_FIELD_DEFS = [
  { id: 'f1', name: 'Notes Field', slug: null, type: 'text', options: null, multiple: false, displayOrder: 0, pinned: false },
  { id: 'f2', name: 'Flag Field', slug: null, type: 'binary', options: null, multiple: false, displayOrder: 1, pinned: false },
  { id: 'f3', name: 'Choice Field', slug: null, type: 'dropdown', options: ['Option A', 'Option B'], multiple: false, displayOrder: 2, pinned: false },
  { id: 'f4', name: 'Date Field', slug: null, type: 'date', options: null, multiple: false, displayOrder: 3, pinned: false },
]

function makeMockApiFetch(overrides: Record<string, unknown> = {}) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return CUSTOM_FIELD_DEFS as never
    if (path === '/notifications/mark-read-by-bill/42') return {} as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

function renderBillDetail({ demoLocked }: { demoLocked: boolean }) {
  demoState.demoLocked = demoLocked
  makeMockApiFetch()
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

beforeEach(() => {
  resetRouterMock()
  authState.role = 'admin'
  authState.canVote = true
  demoState.demoLocked = false
})

describe('BillDetail write controls when demoLocked', () => {
  it('disables the official position select', async () => {
    renderBillDetail({ demoLocked: true })
    expect(await screen.findByRole('combobox', { name: /position/i })).toBeDisabled()
  })

  it('disables the priority select', async () => {
    renderBillDetail({ demoLocked: true })
    expect(await screen.findByRole('combobox', { name: /priority/i })).toBeDisabled()
  })

  it('disables comment edit and delete, even for the current user\'s own comment', async () => {
    renderBillDetail({ demoLocked: true })
    await screen.findByText('My own comment')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('disables the reaction toggle and the add-reaction control', async () => {
    renderBillDetail({ demoLocked: true })
    expect(await screen.findByRole('button', { name: '👍 1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /add reaction/i })).toBeDisabled()
  })

  it('disables the comment composer submit', async () => {
    renderBillDetail({ demoLocked: true })
    expect(await screen.findByRole('button', { name: 'Post' })).toBeDisabled()
  })

  it('disables the vote buttons', async () => {
    renderBillDetail({ demoLocked: true })
    expect(await screen.findByRole('button', { name: 'Support' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Neutral' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Oppose' })).toBeDisabled()
  })

  it('disables the custom-field editors (text, binary, dropdown, date)', async () => {
    renderBillDetail({ demoLocked: true })
    expect(await screen.findByRole('button', { name: /edit notes field/i })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /flag field/i })).toBeDisabled()
    // The dropdown trigger's accessible name is its current display value
    // (the Picker's own aria-label lives on the option panel, not the trigger).
    expect(screen.getByRole('button', { name: 'Option A' })).toBeDisabled()
    expect(screen.getByLabelText(/date field/i)).toBeDisabled()
  })

  it('disables entering edit mode on the personal note', async () => {
    renderBillDetail({ demoLocked: true })
    const note = await screen.findByRole('button', { name: /personal note/i })
    expect(note).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('BillDetail write controls when not demoLocked', () => {
  it('leaves the position select enabled', async () => {
    renderBillDetail({ demoLocked: false })
    expect(await screen.findByRole('combobox', { name: /position/i })).toBeEnabled()
  })

  it('leaves the priority select enabled', async () => {
    renderBillDetail({ demoLocked: false })
    expect(await screen.findByRole('combobox', { name: /priority/i })).toBeEnabled()
  })

  it('leaves comment edit/delete, reactions, composer, votes, and custom fields enabled', async () => {
    renderBillDetail({ demoLocked: false })
    await screen.findByText('My own comment')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '👍 1' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /add reaction/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Support' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /edit notes field/i })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: /flag field/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Option A' })).toBeEnabled()
  })
})
