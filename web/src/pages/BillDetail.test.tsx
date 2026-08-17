import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail, countClippedSponsors } from './BillDetail'
import * as api from '../lib/api'

// ── Route params (mutable so individual tests can vary route + nav state) ──────
const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' } as {
    state: unknown; pathname: string; hash: string; search: string
  },
  // The route loader runs before render in the real app; when rendering BillDetail
  // directly we feed its result through this (set by makeMockApiFetch).
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
    // BillDetail derives prev/next "pending" from the router's navigation state;
    // under a plain MemoryRouter the real useNavigation has no data-router context,
    // so stub it idle.
    useNavigation: () => ({ state: 'idle' }),
    useLocation: () => routerMock.location,
    useLoaderData: () => routerMock.loaderData,
  }
})

// ── Scroll container (jsdom has no .scrollTo) ─────────────────────────────────
vi.mock('../lib/scrollUtils', () => ({
  getScrollContainer: () => ({ scrollTo: vi.fn() }),
}))

// ── Heavy editor components that break in jsdom ───────────────────────────────
vi.mock('../components/RichTextEditor', () => ({
  RichTextEditor: () => null,
}))

// ── PositionBadge: render tooltip as data-tooltip attr for testability ─────────
vi.mock('../components/PositionBadge', () => ({
  PositionBadge: ({ position, tooltip }: { position: string; tooltip?: string }) => (
    <span data-tooltip={tooltip}>{position}</span>
  ),
}))

// ── Hooks / contexts ──────────────────────────────────────────────────────────
const authState = vi.hoisted(() => ({ role: 'member' as 'member' | 'admin' | 'owner', canVote: false }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, subtitle: null, canVote: authState.canVote },
    loading: false,
  }),
}))

// Mutable so the demo-tenant cases below can flip demoMode/settled without a
// per-test module mock. Defaults mirror a settled non-demo tenant, which is what
// every other test in this file assumes.
const demoState = vi.hoisted(() => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ ...demoState }),
}))

vi.mock('../context/SidebarRefreshContext', () => ({
  useSidebarRefresh: () => vi.fn(),
}))

// mentionIds drives a *fresh* mentions array on every call — mirroring the real
// NotificationsProvider, whose refresh() calls setMentions(freshArrayFromJSON)
// (NotificationsContext.tsx), so mentions never keeps a stable identity across
// renders. Empty by default so existing tests, which don't care about mentions,
// see a merely-empty (not undefined) array.
const notifState = vi.hoisted(() => ({
  mentionIds: [] as string[],
  refresh: vi.fn(async () => {}),
}))
vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({
    unreadCount: 0,
    mentions: notifState.mentionIds.map(id => ({ id, billId: '42' })),
    refresh: notifState.refresh,
  }),
}))

vi.mock('../hooks/usePolling', () => ({
  usePolling: () => {},
}))

vi.mock('../hooks/usePageTitle', () => ({
  usePageTitle: () => {},
}))

// ── Minimal bill fixture ──────────────────────────────────────────────────────
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
  myNote: null,
  priorityMeta: null,
  position: { position: 'support', setByName: 'Admin', updatedAt: '2025-01-01 00:00:00' },
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

function makeMockApiFetch(overrides: Record<string, unknown> = {}) {
  // BillDetail now reads the bill from the route loader (useLoaderData), so seed
  // that with the same fixture+overrides the bill fetch used to return.
  routerMock.loaderData = { ...BILL, ...overrides }
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return { ...BILL, ...overrides } as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/notifications/mark-read-by-bill/42') return {} as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

beforeEach(resetRouterMock)
afterEach(() => {
  notifState.mentionIds = []
  notifState.refresh.mockClear()
})

describe('BillDetail org noun labels', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the position section header using orgPositionLabel', async () => {
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Association position')).toBeInTheDocument()
  })

  it('renders the relevance chip label using orgRelevanceLabel', async () => {
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Association relevance')).toBeInTheDocument()
  })

  it('renders the position badge tooltip using orgNoun possessive', async () => {
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    // Wait for bill to load and position section to appear
    await screen.findByText('Association position')
    // PositionBadge is mocked to expose the tooltip prop as data-tooltip
    const badge = document.querySelector('[data-tooltip]')
    expect(badge?.getAttribute('data-tooltip')).toBe("Your association's official position on this bill")
  })
})

describe('BillDetail item dates', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows the recovered date for a document whose structured date is missing', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({
      supplements: [
        {
          supplementId: 1,
          typeId: 2,
          type: 'Analysis',
          date: '0000-00-00',
          dateResolved: '2026-05-21',
          dateInferred: true,
          title: 'Analysis',
          description: 'Statement SSG 5/21/26 SCS SR99',
          mime: 'text/html',
          url: null,
          stateLink: 'https://x',
        },
      ],
    })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    // Wait for bill to load
    await screen.findByText('Test Bill')
    // Open the Documents collapsible section
    const docsButton = screen.getByRole('button', { name: /documents/i })
    await user.click(docsButton)
    // The recovered date should appear in the documents table
    expect(await screen.findByText('2026-05-21')).toBeInTheDocument()
  })
})

describe('BillDetail stuck-state repair affordance', () => {
  beforeEach(() => { vi.restoreAllMocks(); authState.role = 'member' })

  // A tracked bill with text present in R2 but no AI output yet = the dead state.
  const STUCK = { matchType: 'manual' as const, textStatus: 'in_r2' as const, aiProcessedAt: null, aiSkipReason: null, tenantSummary: null }

  it('shows a Run analysis button to admins for a stuck tracked bill', async () => {
    authState.role = 'admin'
    makeMockApiFetch(STUCK)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    expect(await screen.findByRole('button', { name: /run analysis/i })).toBeInTheDocument()
  })

  it('does NOT show the keyword-adjust link for a stuck tracked bill (that is lightweight-only)', async () => {
    authState.role = 'admin'
    makeMockApiFetch(STUCK)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    await screen.findByRole('button', { name: /run analysis/i })
    expect(screen.queryByText(/Adjust keywords/i)).not.toBeInTheDocument()
  })

  it('shows nothing extra to members for a stuck tracked bill (unchanged behavior)', async () => {
    authState.role = 'member'
    makeMockApiFetch(STUCK)
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    expect(screen.queryByRole('button', { name: /run analysis|enable full analysis/i })).not.toBeInTheDocument()
  })

  it('still shows Enable full analysis (not Run analysis) for a lightweight stub to admins', async () => {
    authState.role = 'admin'
    makeMockApiFetch({ matchType: null, textStatus: 'available', aiProcessedAt: null, aiSkipReason: null, tenantSummary: null })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    expect(await screen.findByRole('button', { name: /enable full analysis/i })).toBeInTheDocument()
  })
})

describe('BillDetail deferred-nav via /bills/:id (calendar chips, etc.)', () => {
  beforeEach(() => vi.restoreAllMocks())

  // Calendar chips navigate to /bills/:id (no sessionSlug) with prefetchedBill in
  // state. BillDetail must honor the prefetched bill instead of re-fetching (which
  // showed the center spinner on top of the wait cursor).
  it('renders from prefetchedBill without re-fetching the bill, even when arriving via /bills/:id', async () => {
    routerMock.params = { billId: '42' }
    routerMock.location = { state: { prefetchedBill: BILL }, pathname: '/bills/42', hash: '', search: '' }
    const spy = makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Test Bill')).toBeInTheDocument()
    // The prefetched data must be used — no fetch of the bill itself (no spinner).
    expect(spy).not.toHaveBeenCalledWith('/bills/42')
  })
})

describe('BillDetail vote failure rollback', () => {
  beforeEach(() => { vi.restoreAllMocks(); authState.role = 'member'; authState.canVote = true })
  afterEach(() => { authState.canVote = false })

  // Changing an existing vote (support → oppose) and having the request fail must
  // roll the optimistic UI all the way back to the prior vote — not leave the
  // count decremented while the old choice still shows selected (a desync bug).
  it('reverts to the previous vote when changing a vote fails', async () => {
    const user = userEvent.setup()
    // BillDetail seeds from the route loader (useLoaderData), so the starting
    // vote state must be on loaderData, not just the bill fetch.
    routerMock.loaderData = { ...BILL, myVote: 'support', voteCounts: { support: 1, oppose: 0, neutral: 0, total: 1 } }
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/42') return { ...BILL, myVote: 'support', voteCounts: { support: 1, oppose: 0, neutral: 0, total: 1 } } as never
      if (path === '/config') return { ...CONFIG } as never
      if (path === '/config/custom-fields') return [] as never
      if (path === '/notifications/mark-read-by-bill/42') return {} as never
      if (path === '/roles') return [] as never
      if (path === '/users') return [] as never
      if (path === '/bills/42/votes') throw new api.ApiError(500, 'fail')
      return {} as never
    })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const supportRow = screen.getByRole('button', { name: 'Support' }).parentElement!.parentElement!
    const oppic = screen.getByRole('button', { name: 'Oppose' }).parentElement!.parentElement!
    // Baseline: support shows its 1 vote, oppose shows 0.
    expect(within(supportRow).getByText('1')).toBeInTheDocument()
    expect(within(oppic).getByText('0')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Oppose' }))

    // After the failed request settles, the count must be back where it started.
    await waitFor(() => {
      expect(within(supportRow).getByText('1')).toBeInTheDocument()
      expect(within(oppic).getByText('0')).toBeInTheDocument()
    })
  })
})

describe('BillDetail draft admin inline edit (title/sponsor) keyboard access', () => {
  beforeEach(() => { vi.restoreAllMocks(); authState.role = 'admin' })
  afterEach(() => { authState.role = 'member' })

  // The title and sponsor "click to edit" affordances are admin-only controls
  // shown on draft bills. They must be real, keyboard-operable buttons — not
  // divs/spans that only respond to a mouse click.
  it('lets an admin enter title-edit mode from the keyboard', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({ isDraft: true })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const edit = screen.getByRole('button', { name: /edit title/i })
    edit.focus()
    await user.keyboard('{Enter}')

    // Scope to the draft-title input by name: the draft banner's BillPicker
    // also renders a "Search bills…" textbox, so an unscoped role query would
    // be ambiguous.
    expect(document.querySelector('input[name="draftTitle"]')).toBeInTheDocument()
  })

  // <button> permits only phrasing content, and <h1> is not phrasing content,
  // so a <button><h1>…</h1></button> nesting is an invalid HTML5 content
  // model. The edit control must live inside the heading, not wrap it.
  it('exposes the title as a valid level-1 heading with the edit button inside it, not wrapping it', async () => {
    makeMockApiFetch({ isDraft: true })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const heading = screen.getByRole('heading', { level: 1 })
    const edit = screen.getByRole('button', { name: /edit title/i })

    expect(heading.contains(edit)).toBe(true)
    expect(edit.contains(heading)).toBe(false)
  })

  it('lets an admin enter sponsor-edit mode from the keyboard', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({ isDraft: true, sponsor: null })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const edit = screen.getByRole('button', { name: /edit sponsor/i })
    edit.focus()
    await user.keyboard('{Enter}')

    expect(document.querySelector('input[name="draftSponsor"]')).toBeInTheDocument()
  })
})

describe('BillDetail draft admin inline edit (summary/text) keyboard access', () => {
  beforeEach(() => { vi.restoreAllMocks(); authState.role = 'admin' })
  afterEach(() => { authState.role = 'member' })

  // The draft summary and bill-text "click to edit" affordances are admin-only
  // controls, same as title/sponsor. They must be real, keyboard-operable
  // buttons — not divs that only respond to a mouse click.
  it('lets an admin enter summary-edit mode from the keyboard', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({ isDraft: true })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const edit = screen.getByRole('button', { name: /edit summary/i })
    edit.focus()
    await user.keyboard('{Enter}')

    // RichTextEditor is mocked to render null, so entering edit mode removes
    // the read-only edit affordance from the DOM — confirming the handler fired.
    expect(screen.queryByRole('button', { name: /edit summary/i })).not.toBeInTheDocument()
  })

  it('lets an admin enter bill-text-edit mode from the keyboard', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({ isDraft: true })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const edit = screen.getByRole('button', { name: /edit bill text/i })
    edit.focus()
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('button', { name: /edit bill text/i })).not.toBeInTheDocument()
  })

  it('does not render summary/text edit affordances as buttons for non-admins', async () => {
    authState.role = 'member'
    makeMockApiFetch({ isDraft: true })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    expect(screen.queryByRole('button', { name: /edit summary/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit bill text/i })).not.toBeInTheDocument()
  })
})

describe('BillDetail pinned custom field inline edit keyboard access', () => {
  beforeEach(() => { vi.restoreAllMocks(); authState.role = 'admin' })
  afterEach(() => { authState.role = 'member' })

  function mockWithPinnedField() {
    const billWithField = {
      ...BILL,
      customFieldValues: { f1: { value: 'Committee notes here', setBy: 'Admin', updatedAt: '2025-01-01 00:00:00' } },
    }
    routerMock.loaderData = billWithField
    return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/42') return billWithField as never
      if (path === '/config') return { ...CONFIG } as never
      if (path === '/config/custom-fields') return [
        { id: 'f1', name: 'Committee Notes', slug: null, type: 'text', options: null, multiple: false, displayOrder: 0, pinned: true },
      ] as never
      if (path === '/notifications/mark-read-by-bill/42') return {} as never
      if (path === '/roles') return [] as never
      if (path === '/users') return [] as never
      return {} as never
    })
  }

  // The pinned custom field "click to edit" affordance is admin-only, same
  // pattern as title/sponsor/summary/text — must be keyboard-operable.
  it('renders the pinned custom field edit affordance as a button and enters edit mode from the keyboard', async () => {
    const user = userEvent.setup()
    mockWithPinnedField()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    // A pinned field with a value also renders in the full custom-fields list
    // further down the page (CustomFieldsSection), so there are two buttons
    // with this accessible name — the pinned box's is first in DOM order.
    const edits = await screen.findAllByRole('button', { name: /edit committee notes/i })
    expect(edits.length).toBeGreaterThanOrEqual(1)
    const edit = edits[0]
    edit.focus()
    await user.keyboard('{Enter}')

    // RichTextEditor is mocked to render null, so entering edit mode removes
    // just the pinned box's edit affordance — one fewer button afterward.
    const remaining = screen.queryAllByRole('button', { name: /edit committee notes/i })
    expect(remaining.length).toBe(edits.length - 1)
  })

  it('does not render the pinned custom field edit affordance as a button for non-admins', async () => {
    authState.role = 'member'
    mockWithPinnedField()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    // The same value also appears in the full custom-fields list elsewhere on
    // the page, so there are multiple matches — findAllByText both waits for
    // render and tolerates that, unlike findByText.
    await screen.findAllByText('Committee notes here')

    expect(screen.queryByRole('button', { name: /edit committee notes/i })).not.toBeInTheDocument()
  })
})

describe('BillDetail deferred-nav entry (prefetchedBill without billPaths)', () => {
  beforeEach(() => vi.restoreAllMocks())

  // Arriving via useBillNavigate from Feed / sidebar / calendar / notifications:
  // canonical route, router state carries prefetchedBill but NO billPaths/currentIndex.
  // Regression: BillDetail used to read navState.billPaths.length unconditionally,
  // throwing "Cannot read properties of undefined (reading 'length')" → blank page.
  it('renders the prefetched bill and does not crash when billPaths is absent', async () => {
    routerMock.params = { state: 'RI', sessionSlug: '2025-2026', billNumber: 'HB1' }
    routerMock.location = { state: { prefetchedBill: BILL }, pathname: '/RI/2025-2026/HB1', hash: '', search: '' }
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Test Bill')).toBeInTheDocument()
    expect(screen.getByText('Association position')).toBeInTheDocument()
  })
})

// ── Sponsors row: overflow-driven co-sponsor reveal ───────────────────────────
// The collapsed row shows sponsors on one line and reveals a "+N more" toggle
// only when the line actually overflows. Because that decision is layout-driven
// (and jsdom has no layout), the clip math lives in a pure helper we test directly.
describe('countClippedSponsors', () => {
  it('counts items whose right edge falls past the boundary', () => {
    expect(countClippedSponsors([40, 120, 260, 400], 200)).toBe(2)
  })

  it('returns 0 when every item fits within the boundary', () => {
    expect(countClippedSponsors([40, 120, 195], 200)).toBe(0)
  })

  it('tolerates sub-pixel overhang at the boundary', () => {
    expect(countClippedSponsors([200.4], 200)).toBe(0)
  })
})

describe('BillDetail sponsors row', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders every co-sponsor in the DOM, not just the first five', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `Cosponsor ${i + 1}`, party: 'D', url: null, primary: false,
    }))
    makeMockApiFetch({ sponsor: 'Prime Sponsor', coSponsors: many })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    expect(await screen.findByText('Prime Sponsor')).toBeInTheDocument()
    expect(screen.getByText('Cosponsor 9')).toBeInTheDocument()
  })
})

describe('BillDetail reaction hover name list stays in sync with the count', () => {
  beforeEach(() => { vi.restoreAllMocks(); authState.role = 'member' })

  // The hover tooltip on an emoji pill lists the people who reacted (reactors).
  // The optimistic update used to bump `count` but not `reactors`, so a user's
  // own name was missing (on add) or lingering (on remove) from the tooltip
  // until the 15s poll — usePolling is mocked off here, so the tooltip reflects
  // the optimistic update alone. Current user (useAuth mock) is Alice.
  const COMMENT = {
    id: 'c1',
    userId: 'u2',
    userName: 'Carol',
    userSubtitle: null,
    content: 'Nice bill',
    createdAt: '2025-01-02 00:00:00',
  }
  // The tooltip is always in the DOM (display:none), so its reactor names are
  // queryable without simulating hover.
  const tipFor = (pill: HTMLElement) => pill.parentElement!.querySelector('.reaction-tip')!

  it('adds the current user to the hover name list immediately on reacting', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({
      comments: [{ ...COMMENT, reactions: [{ emoji: '👍', count: 1, userReacted: false, reactors: [{ name: 'Bob', subtitle: null }] }] }],
      commentsTotal: 1,
    })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const pill = await screen.findByRole('button', { name: '👍 1' })
    expect(tipFor(pill).textContent).toContain('Bob')
    expect(tipFor(pill).textContent).not.toContain('Alice')

    await user.click(pill)

    await waitFor(() => {
      const bumped = screen.getByRole('button', { name: '👍 2' })
      expect(tipFor(bumped).textContent).toContain('Alice')
    })
  })

  it('removes the current user from the hover name list immediately on un-reacting', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({
      comments: [{ ...COMMENT, reactions: [{ emoji: '👍', count: 2, userReacted: true, reactors: [{ name: 'Bob', subtitle: null }, { name: 'Alice', subtitle: null }] }] }],
      commentsTotal: 1,
    })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    const pill = await screen.findByRole('button', { name: '👍 2' })
    expect(tipFor(pill).textContent).toContain('Alice')

    await user.click(pill)

    await waitFor(() => {
      const dropped = screen.getByRole('button', { name: '👍 1' })
      expect(tipFor(dropped).textContent).toContain('Bob')
      expect(tipFor(dropped).textContent).not.toContain('Alice')
    })
  })
})

describe('BillDetail mark-read-by-bill effect', () => {
  it('POSTs mark-read-by-bill exactly once, even though mentions has no stable identity across renders', async () => {
    // Regression test for a self-retriggering loop: the effect used to depend on
    // `mentions` directly and called refreshNotifications() in its own body. Since
    // the real NotificationsProvider.refresh() always calls setMentions(a fresh
    // array), and the mock here reproduces that by rebuilding the array on every
    // call, a `[mentions]` dependency retriggers the effect every time it's read
    // during one of BillDetail's own re-renders — POST, refresh, re-render, POST,
    // forever. The fix depends on a value-stable joined-ids string instead.
    notifState.mentionIds = ['m1']
    const spy = makeMockApiFetch()
    // vi.spyOn reuses the same instance across tests in this file (nothing here
    // resets it globally), so its call history carries over from whatever ran
    // before this test. Clear it after wiring the new mock but before mounting,
    // so only calls this render makes are counted.
    spy.mockClear()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')

    // Give any runaway effect several turns of the microtask/macrotask queue to
    // retrigger before asserting — a single findBy resolving is not enough time
    // for a synchronous-ish loop to reveal itself.
    await new Promise(r => setTimeout(r, 50))

    const markReadCalls = spy.mock.calls.filter(([path]) => path === '/notifications/mark-read-by-bill/42')
    expect(markReadCalls).toHaveLength(1)
  })

  describe('on a demo tenant', () => {
    afterEach(() => {
      demoState.demoMode = false
      demoState.settled = true
      localStorage.clear()
    })

    it('records read state in localStorage instead of POSTing', async () => {
      // Every demo visitor is the same `demo-user` row, so a server-side
      // mark-read clears the badge for everyone after them until the reset cron
      // re-lights it. See lib/demoReadState.ts.
      demoState.demoMode = true
      notifState.mentionIds = ['m1', 'm2']
      const spy = makeMockApiFetch()
      spy.mockClear()
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Test Bill')

      const { readMentionIds } = await import('../lib/demoReadState')
      await waitFor(() => expect(readMentionIds(demoState.demoResetAt)).toEqual(new Set(['m1', 'm2'])))
      expect(spy.mock.calls.filter(([path]) => path === '/notifications/mark-read-by-bill/42')).toHaveLength(0)
    })

    // DemoProvider starts at demoMode:false and only learns the truth when
    // GET /config resolves, so a cold direct load of a demo bill URL renders
    // this effect at least once before the gate can flip. Without `settled` the
    // POST goes out in that window and writes read_at on the shared row.
    it('POSTs nothing while /config is still in flight', async () => {
      demoState.settled = false
      notifState.mentionIds = ['m1']
      const spy = makeMockApiFetch()
      spy.mockClear()
      render(<MemoryRouter><BillDetail /></MemoryRouter>)
      await screen.findByText('Test Bill')
      await new Promise(r => setTimeout(r, 50))

      expect(spy.mock.calls.filter(([path]) => path === '/notifications/mark-read-by-bill/42')).toHaveLength(0)
      const { readMentionIds } = await import('../lib/demoReadState')
      expect(readMentionIds(demoState.demoResetAt)).toEqual(new Set())
    })
  })
})
