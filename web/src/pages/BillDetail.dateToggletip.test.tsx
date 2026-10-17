import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
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
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, title: null, canVote: authState.canVote },
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
    notifications: notifState.mentionIds.map(id => ({ kind: 'mention', id, billId: '42' })),
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
  // Non-null and coherent with the other timestamps: the queue processor writes
  // tenantSummary/tags/relevanceScore/aiProcessedAt in one statement, so a
  // fixture carrying analysis fields must carry the timestamp too. Tests that
  // want the analysis-absent or stuck shapes clear all four explicitly.
  aiProcessedAt: '2025-01-01 00:00:00',
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

const changesFixture = vi.hoisted(() => ({ changes: [] as unknown[] }))

function makeMockApiFetch(overrides: Record<string, unknown> = {}) {
  // BillDetail now reads the bill from the route loader (useLoaderData), so seed
  // that with the same fixture+overrides the bill fetch used to return.
  routerMock.loaderData = { ...BILL, ...overrides }
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return { ...BILL, ...overrides } as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/notifications/mark-read-by-bill/42') return {} as never
    if (path === '/bills/42/changes') return { changes: changesFixture.changes } as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

// A recovered date is marked with a toggletip (#579), like the dotted-underline
// term explainers (#575): click, tap, Enter, or Space pins "Date parsed from
// title" open or closed, Escape closes it, hover and focus still preview it, and
// the date is a real button with the pointer cursor, never inside a link or
// another button.
const EXPLAINER = 'Date parsed from title'
const bubble = () => screen.getAllByText(EXPLAINER).find(el => el.style.position === 'fixed')
const supplement = (over: Record<string, unknown> = {}) => ({
  supplementId: 1, typeId: 2, type: 'Analysis', date: '0000-00-00', dateResolved: '2026-05-21', dateInferred: true,
  title: 'Analysis', description: 'Statement 5/21/26', mime: 'text/html', url: null, stateLink: 'https://x', ...over,
})
const amendment = (over: Record<string, unknown> = {}) => ({
  amendmentId: 7, adopted: false, chamber: 'S', date: '0000-00-00', dateResolved: '2026-04-02', dateInferred: true,
  title: 'Amendment', description: 'Floor amendment', mime: 'text/html', url: null, stateLink: 'https://y', ...over,
})

// BillDetail's DOM is large enough that role-and-name queries time out, so find the
// text and take the button around it; a missing button fails the assertion here.
function asButton(el: HTMLElement): HTMLElement {
  const btn = el.closest('button')
  expect(btn, `a button around "${el.textContent}"`).not.toBeNull()
  return btn as HTMLElement
}

async function openDocuments(over: Record<string, unknown> = {}) {
  const user = userEvent.setup()
  makeMockApiFetch({ supplements: [supplement(over)] })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  await screen.findByText('Test Bill')
  await user.click(screen.getByText(/^Documents/).closest('button')!)
  const date = asButton(await screen.findByText('2026-05-21'))
  return { user, date }
}

beforeEach(() => { resetRouterMock(); vi.restoreAllMocks(); changesFixture.changes = [] })

describe('the recovered date on a bill page is a toggletip', () => {
  it('opens on a click and closes on a second click', async () => {
    const { user, date } = await openDocuments()
    expect(bubble()).toBeUndefined()
    await user.click(date)
    expect(bubble()).toBeDefined()
    await user.click(date)
    expect(bubble()).toBeUndefined()
  })

  it('opens on a tap and closes on a second tap', async () => {
    const { user, date } = await openDocuments()
    await user.pointer({ keys: '[TouchA]', target: date })
    expect(bubble()).toBeDefined()
    await user.pointer({ keys: '[TouchA]', target: date })
    expect(bubble()).toBeUndefined()
  })

  it('a click pins it open after the mouse leaves', async () => {
    const { user, date } = await openDocuments()
    await user.click(date)
    fireEvent.pointerLeave(date, { pointerType: 'mouse' })
    expect(bubble()).toBeDefined()
  })

  it('Enter toggles it: the first pins the focus preview, the second closes', async () => {
    const { user, date } = await openDocuments()
    act(() => date.focus())
    expect(bubble()).toBeDefined() // focus preview
    await user.keyboard('{Enter}')
    expect(bubble()).toBeDefined() // pinned
    await user.keyboard('{Enter}')
    expect(bubble()).toBeUndefined()
  })

  it('Space toggles it the same way', async () => {
    const { user, date } = await openDocuments()
    act(() => date.focus())
    await user.keyboard(' ')
    expect(bubble()).toBeDefined()
    await user.keyboard(' ')
    expect(bubble()).toBeUndefined()
  })

  it('Escape closes a click-pinned explainer, keeping focus, and the next click opens it again', async () => {
    const { user, date } = await openDocuments()
    await user.click(date)
    await user.keyboard('{Escape}')
    expect(bubble()).toBeUndefined()
    expect(date).toHaveFocus()
    await user.click(date)
    expect(bubble()).toBeDefined()
  })

  it('previews on hover and hides when an unpinned hover leaves', async () => {
    const { date } = await openDocuments()
    fireEvent.pointerEnter(date, { pointerType: 'mouse' })
    expect(bubble()).toBeDefined()
    fireEvent.pointerLeave(date, { pointerType: 'mouse' })
    expect(bubble()).toBeUndefined()
  })

  it('previews on focus and hides on blur', async () => {
    const { date } = await openDocuments()
    act(() => date.focus())
    expect(bubble()).toBeDefined()
    act(() => date.blur())
    expect(bubble()).toBeUndefined()
  })

  it('is a button with the pointer cursor, a dotted underline, and the explainer as its description', async () => {
    const { date } = await openDocuments()
    expect(date.tagName).toBe('BUTTON')
    expect(date).toHaveAttribute('type', 'button')
    expect(date.style.cursor).toBe('pointer')
    expect(date.firstElementChild).not.toBeNull()
    expect((date.firstElementChild as HTMLElement).style.borderBottom).toContain('dotted')
    expect(date).toHaveAccessibleDescription(EXPLAINER)
    for (const el of Array.from(date.querySelectorAll<HTMLElement>('*'))) expect(el.style.cursor).not.toBe('default')
  })

  it('is not nested inside a link or button', async () => {
    const { date } = await openDocuments()
    expect(date.closest('a')).toBeNull()
    expect(date.parentElement?.closest('button')).toBeNull()
    expect(date.querySelector('a, button')).toBeNull()
  })

  it('a date the source gave outright stays plain text: no button, no underline', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({ supplements: [supplement({ date: '2026-05-21', dateInferred: false })] })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    await user.click(screen.getByText(/^Documents/).closest('button')!)
    const date = await screen.findByText('2026-05-21')
    expect(date.closest('button')).toBeNull()
    expect(date.style.borderBottom).toBe('')
  })

  it('an amendment\'s recovered date works the same way', async () => {
    const user = userEvent.setup()
    makeMockApiFetch({ amendments: [amendment()] })
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    await screen.findByText('Test Bill')
    await user.click(screen.getByText(/^Amendments/).closest('button')!)
    const date = asButton(await screen.findByText('2026-04-02'))
    expect(date.style.cursor).toBe('pointer')
    expect(date.closest('a')).toBeNull()
    await user.click(date)
    expect(bubble()).toBeDefined()
    await user.keyboard('{Escape}')
    expect(bubble()).toBeUndefined()
  })
})

describe('the change-history trigger on a bill page', () => {
  const change = { changeType: 'status_change', oldValue: 'Introduced', newValue: 'In Committee', detail: null, detectedAt: '2026-06-01 12:00:00' }

  it('is a button that opens the change log on click, and is not inside a link or button', async () => {
    const user = userEvent.setup()
    changesFixture.changes = [change]
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    const trigger = asButton(await screen.findByText(/^Updated /))
    expect(trigger.style.cursor).toBe('pointer')
    expect(trigger.closest('a')).toBeNull()
    expect(trigger.parentElement?.closest('button')).toBeNull()
    expect(screen.queryByText('Change log')).toBeNull()
    await user.click(trigger)
    expect(screen.getByText('Change log')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('Change log')).toBeNull()
  })

  it('is outside the bill title, which is not a link on this page', async () => {
    changesFixture.changes = [change]
    makeMockApiFetch()
    render(<MemoryRouter><BillDetail /></MemoryRouter>)
    const trigger = await screen.findByText(/^Updated /)
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.contains(trigger)).toBe(false)
    expect(heading.closest('a')).toBeNull()
    expect(heading.querySelector('a')).toBeNull()
  })
})
