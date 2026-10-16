import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// Regenerate re-analyzes the bill whose analysis the page shows (#563). On a
// grouped bill that is the group's analysis bill (#554), which on a pulled
// companion's page is the tracked bill, and the run is polled on that bill's
// analysis time. The scaffolding is BillDetail.companionGroup.test.tsx's.

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

vi.mock('../components/RichTextEditor', () => ({
  RichTextEditor: () => null,
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

// A bill in no group: its own analysis is the one it shows.
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
  aiProcessedAt: '2026-09-01 00:00:00',
  aiSkipReason: null,
  analysisBillId: '42',
  analysisBillExternalId: 'legiscan:42',
  analysisBillNumber: 'HB 1',
  analysisAiProcessedAt: '2026-09-01 00:00:00',
  analysisAiSkipReason: null,
  analysisTextStatus: 'in_r2',
  lastAiTextDocId: null,
  textStatus: 'in_r2' as const,
  myVote: null,
  myNote: null,
  priorityMeta: null,
  position: { position: 'support', setByName: 'Admin', updatedAt: '2025-01-01 00:00:00' },
  voteCounts: { support: 1, oppose: 0, neutral: 0, total: 1 },
  memberVotes: [],
  comments: [],
  commentsTotal: 0,
}

// Page 42 is S1713, a pulled companion of A190 (the tracked bill). Its own
// analysis, newer than A190's, is not shown: the page shows A190's.
const COMPANION = {
  billNumber: 'S1713',
  matchType: null,
  aiProcessedAt: '2026-09-05 00:00:00',
  textStatus: 'available' as const,
  analysisBillId: 'a190',
  analysisBillExternalId: 'legiscan:190',
  analysisBillNumber: 'A190',
  analysisAiProcessedAt: '2026-09-01 00:00:00',
  analysisAiSkipReason: null,
  analysisTextStatus: 'in_r2',
  tenantSummary: "A190's summary.",
}

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * Renders the page for a bill, and stands in for the server: each poll of
 * `/api/bills/42` returns the next of `polls` (the last one repeating), each
 * the page bill's detail with these overrides on it.
 */
let n = 0
function setup(page: Record<string, unknown>, polls: Array<Record<string, unknown>> = [], afterRun: Record<string, unknown> = {}) {
  const bill = { ...BILL, ...page }
  n = 0
  routerMock.loaderData = bill
  const apiFetch = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    // The page reloads itself when a run ends: with `afterRun` on it, the bill as the run left it.
    if (path === '/bills/42') return (n > 0 ? { ...bill, ...afterRun } : bill) as never
    if (path.startsWith('/bills/')) return routerMock.loaderData as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles' || path === '/users') return [] as never
    return {} as never
  })
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if ((init as RequestInit | undefined)?.method === 'POST') return json({ queued: 1, ok: true })
    if (url === '/api/bills/42') {
      const next = polls[Math.min(n, polls.length - 1)] ?? {}
      n++
      return json({ ...bill, ...next })
    }
    return json({})
  })
  const view = render(<MemoryRouter><BillDetail /></MemoryRouter>)
  /** Moves to another bill's page, as following a link to it does. */
  const goTo = (billId: string, detail: Record<string, unknown>) => {
    routerMock.params = { billId }
    routerMock.location = { ...routerMock.location, pathname: `/bills/${billId}` }
    routerMock.loaderData = { ...BILL, ...detail }
    view.rerender(<MemoryRouter><BillDetail /></MemoryRouter>)
  }
  const posts = () => fetchSpy.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST').map(c => String(c[0]))
  const polled = () => fetchSpy.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method !== 'POST').map(c => String(c[0]))
  const refetched = () => apiFetch.mock.calls.filter(c => c[0] === '/bills/42').length
  return { posts, polled, refetched, bill, goTo }
}

type User = ReturnType<typeof userEvent.setup>
async function regenerate(user: User) {
  await user.click(await screen.findByRole('button', { name: 'More actions' }))
  await user.click(screen.getByRole('menuitem', { name: /Re-generate/ }))
}

// The progress chip, a status like the outcome notice: tell them apart by text.
const chip = () => screen.queryByText(/Regenerating/)

const tick = (ms = 5000) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

let user: User
beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
  authState.role = 'admin'
  demoState.demoLocked = false
  vi.useFakeTimers({ shouldAdvanceTime: true })
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("Regenerate on a pulled companion's page", () => {
  it("re-analyzes the tracked bill, not the companion", async () => {
    const { posts } = setup(COMPANION, [COMPANION])
    await regenerate(user)
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]).toBe('/api/admin/reprocess-bill/legiscan%3A190')
    expect(posts().some(u => u.includes('promote-bill'))).toBe(false)
  })

  it("re-analyzes the tracked bill even though the companion has no analysis time of its own and no match type", async () => {
    // The stub guard once read the page bill's own fields, so a companion that
    // was never analyzed (aiProcessedAt null, matchType null) was promoted.
    const { posts } = setup({ ...COMPANION, aiProcessedAt: null })
    await regenerate(user)
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]).toBe('/api/admin/reprocess-bill/legiscan%3A190')
  })

  it("polls the page's detail for the tracked bill's analysis time, and ends when it moves", async () => {
    const { polled, refetched } = setup(COMPANION, [
      COMPANION, // the tracked bill's analysis time has not moved yet
      { ...COMPANION, analysisAiProcessedAt: '2026-10-15 12:00:00' },
    ])
    await regenerate(user)
    expect(refetched()).toBe(0) // nothing reloads the page until the run ends
    expect(await screen.findByText(/Regenerating/)).toBeInTheDocument()
    await tick()
    expect(chip()).toBeInTheDocument() // still running after one unchanged poll
    await tick()
    await waitFor(() => expect(chip()).not.toBeInTheDocument())
    expect(polled().length).toBeGreaterThanOrEqual(2)
    expect(polled().every(u => u === '/api/bills/42')).toBe(true)
    // The page refetches, so the summary and tags on it update.
    await waitFor(() => expect(refetched()).toBeGreaterThan(0))
  })

  it("does not end the run on the companion's own analysis time moving", async () => {
    setup(COMPANION, [{ ...COMPANION, aiProcessedAt: '2026-10-15 12:00:00' }])
    await regenerate(user)
    await screen.findByText(/Regenerating/)
    await tick()
    await tick()
    expect(chip()).toBeInTheDocument()
  })

  it("names the tracked bill on the progress chip while it runs", async () => {
    setup(COMPANION, [COMPANION])
    await regenerate(user)
    expect(await screen.findByText('Regenerating A190…')).toBeInTheDocument()
  })

  it("says which bill was re-analyzed when the run lands", async () => {
    setup(COMPANION, [{ ...COMPANION, analysisAiProcessedAt: '2026-10-15 12:00:00' }])
    await regenerate(user)
    await tick()
    expect(await screen.findByText("Re-analyzed A190, the bill this page's summary comes from.")).toBeInTheDocument()
  })

  it("says which bill was re-analyzed when AI skips it", async () => {
    setup(COMPANION, [{ ...COMPANION, analysisAiSkipReason: 'pdf_too_large' }])
    await regenerate(user)
    await tick()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('A190')
    expect(alert).toHaveTextContent("couldn't analyze")
  })

  it("says which bill has no text when the tracked bill's text is missing", async () => {
    setup(COMPANION, [{ ...COMPANION, analysisTextStatus: 'no_texts' }])
    await regenerate(user)
    await tick()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('A190')
    expect(alert).toHaveTextContent('no published bill text')
  })

  it("is not fooled by the companion's own text status", async () => {
    // The companion has no text; the tracked bill, which is what runs, does.
    setup({ ...COMPANION, textStatus: 'no_texts' }, [{ ...COMPANION, textStatus: 'no_texts' }])
    await regenerate(user)
    await tick()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(chip()).toBeInTheDocument()
  })

  it("names the tracked bill when the run times out", async () => {
    setup(COMPANION, [COMPANION])
    await regenerate(user)
    await tick(3 * 60 * 1000 + 6000)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('A190')
    expect(alert).toHaveTextContent('3 minutes')
  })

  it("ends with a clear outcome, not a timeout, when the group splits between the click and the poll", async () => {
    // After the split the page shows the companion's own analysis.
    const split = { ...COMPANION, analysisBillId: '42', analysisBillExternalId: 'legiscan:42', analysisBillNumber: 'S1713', analysisAiProcessedAt: '2026-09-05 00:00:00', tenantSummary: "S1713's own summary." }
    const { refetched } = setup(COMPANION, [COMPANION, split])
    await regenerate(user)
    expect(refetched()).toBe(0)
    await tick()
    await tick()
    const note = await screen.findByText(/group changed while A190 was being re-analyzed, so this page now shows a different bill's summary/)
    expect(note).toBeInTheDocument()
    expect(screen.queryByText(/has not finished/)).not.toBeInTheDocument()
    expect(chip()).not.toBeInTheDocument()
    // It reloads the page, which now shows the bill's own analysis.
    await waitFor(() => expect(refetched()).toBeGreaterThan(0))
  })

  it("ends with a clear outcome when another member starts matching and its analysis takes over", async () => {
    const taken = { ...COMPANION, analysisBillId: 'c9', analysisBillExternalId: 'legiscan:9', analysisBillNumber: 'H9', analysisAiProcessedAt: '2026-10-16 00:00:00' }
    setup(COMPANION, [taken])
    await regenerate(user)
    await tick()
    expect(await screen.findByText(/group changed while A190 was being re-analyzed/)).toBeInTheDocument()
    expect(screen.queryByText(/Re-analyzed A190/)).not.toBeInTheDocument()
  })

  it("clears the last run's outcome when Regenerate is run again", async () => {
    setup(COMPANION, [{ ...COMPANION, analysisAiProcessedAt: '2026-10-15 12:00:00' }])
    await regenerate(user)
    await tick()
    await screen.findByText(/Re-analyzed A190/)
    await regenerate(user)
    expect(screen.queryByText(/Re-analyzed A190/)).not.toBeInTheDocument()
    expect(await screen.findByText('Regenerating A190…')).toBeInTheDocument()
  })

  it("shows the error and no outcome note when reprocess-bill fails", async () => {
    setup(COMPANION, [COMPANION])
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => (
      (init as RequestInit | undefined)?.method === 'POST' ? json({ error: 'Queue not configured' }, 503) : json({})
    ))
    await regenerate(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Queue not configured')
  })

  it("falls back to the tracked bill's id when it has no external id", async () => {
    const { posts } = setup({ ...COMPANION, analysisBillExternalId: null }, [COMPANION])
    await regenerate(user)
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]).toBe('/api/admin/reprocess-bill/a190')
  })
})

describe('Regenerate where the page shows its own bill\'s analysis', () => {
  it("re-analyzes a bill in no group, polls its time, and says nothing when it lands", async () => {
    const { posts, refetched } = setup({}, [{ analysisAiProcessedAt: '2026-10-15 12:00:00', aiProcessedAt: '2026-10-15 12:00:00' }])
    await regenerate(user)
    expect(refetched()).toBe(0)
    await waitFor(() => expect(posts()).toEqual(['/api/admin/reprocess-bill/legiscan%3A42']))
    expect(await screen.findByText('Regenerating…')).toBeInTheDocument()
    await tick()
    await waitFor(() => expect(chip()).not.toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await waitFor(() => expect(refetched()).toBeGreaterThan(0))
  })

  it("re-analyzes a tracked bill from its own page, though a companion is grouped with it", async () => {
    const { posts } = setup({ billNumber: 'A190', groupBills: [{ billId: '42', billNumber: 'A190' }, { billId: 'b1713', billNumber: 'S1713' }] }, [{}])
    await regenerate(user)
    await waitFor(() => expect(posts()).toEqual(['/api/admin/reprocess-bill/legiscan%3A42']))
  })

  it("names no other bill in the outcome of its own failures", async () => {
    setup({}, [{ analysisAiSkipReason: 'pdf_too_large' }])
    await regenerate(user)
    await tick()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("AI couldn't analyze this bill's text.")
    expect(alert).not.toHaveTextContent('the bill this page')
  })

  it("keeps polling past a skip reason the bill already had", async () => {
    setup({ aiSkipReason: 'pdf_too_large', analysisAiSkipReason: 'pdf_too_large' }, [
      { aiSkipReason: 'pdf_too_large', analysisAiSkipReason: 'pdf_too_large' },
    ])
    await regenerate(user)
    await tick()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(chip()).toBeInTheDocument()
  })

  it("re-analyzes the most recently analyzed member's bill when the group has no tracked analysis", async () => {
    // Page 42 is untracked and unanalyzed; the shown analysis is another member's.
    const page = {
      billNumber: 'S1714', matchType: null, aiProcessedAt: null,
      analysisBillId: 'c9', analysisBillExternalId: 'legiscan:9', analysisBillNumber: 'H9',
      analysisAiProcessedAt: '2026-09-03 00:00:00', tenantSummary: "H9's summary.",
    }
    const { posts } = setup(page, [{ ...page, analysisAiProcessedAt: '2026-10-15 12:00:00' }])
    await regenerate(user)
    await waitFor(() => expect(posts()).toEqual(['/api/admin/reprocess-bill/legiscan%3A9']))
    await tick()
    expect(await screen.findByText("Re-analyzed H9, the bill this page's summary comes from.")).toBeInTheDocument()
  })

  it("re-analyzes an untracked bill that holds the group's analysis from its own page", async () => {
    // The group's only analysis is this bill's own, though it has no match type.
    const { posts } = setup({ matchType: null }, [{}])
    await regenerate(user)
    await waitFor(() => expect(posts()).toEqual(['/api/admin/reprocess-bill/legiscan%3A42']))
  })

  it("does not offer Regenerate to a member", async () => {
    authState.role = 'member'
    setup(COMPANION)
    await user.click(await screen.findByRole('button', { name: 'More actions' }))
    expect(screen.queryByRole('menuitem', { name: /Re-generate/ })).not.toBeInTheDocument()
  })
})

describe('Regenerate on a never-analyzed stub', () => {
  it("promotes the bill instead of regenerating it", async () => {
    const stub = {
      matchType: null, aiProcessedAt: null, tenantSummary: null, tags: ['tax'], relevanceScore: null,
      analysisAiProcessedAt: null, analysisTextStatus: null,
    }
    const { posts } = setup(stub, [stub])
    await regenerate(user)
    await waitFor(() => expect(posts()).toEqual(['/api/admin/promote-bill/42']))
  })

  it("promotes the stub from the page of a group whose analysis is its own and unanalyzed", async () => {
    const stub = {
      matchType: null, aiProcessedAt: null, tenantSummary: null, tags: ['tax'], relevanceScore: null,
      analysisBillId: '42', analysisAiProcessedAt: null, groupBills: [{ billId: '42', billNumber: 'HB 1' }, { billId: 'x7', billNumber: 'SB 7' }],
    }
    const { posts } = setup(stub, [stub])
    await regenerate(user)
    await waitFor(() => expect(posts()).toEqual(['/api/admin/promote-bill/42']))
  })
})

describe('the outcome of a run does not outlive its page', () => {
  const TRACKED = { id: 'a190', externalId: 'legiscan:190', billNumber: 'A190', matchType: 'keyword' as const, analysisBillId: 'a190', analysisBillExternalId: 'legiscan:190', analysisBillNumber: 'A190', tenantSummary: "A190's summary." }

  it("clears 'Re-analyzed A190' when the admin goes on to A190's own page", async () => {
    const { goTo } = setup(COMPANION, [{ ...COMPANION, analysisAiProcessedAt: '2026-10-15 12:00:00' }])
    await regenerate(user)
    await tick()
    await screen.findByText(/Re-analyzed A190/)
    act(() => goTo('a190', TRACKED))
    await screen.findByText("A190's summary.")
    expect(screen.queryByText(/Re-analyzed A190/)).not.toBeInTheDocument()
  })

  it("clears a failed run's error when the admin goes to another bill's page", async () => {
    const { goTo } = setup(COMPANION, [{ ...COMPANION, analysisAiSkipReason: 'pdf_too_large' }])
    await regenerate(user)
    await tick()
    await screen.findByRole('alert')
    act(() => goTo('a190', TRACKED))
    await screen.findByText("A190's summary.")
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it("clears the group-changed notice when the admin goes to another bill's page", async () => {
    const split = { ...COMPANION, analysisBillId: '42', analysisBillNumber: 'S1713' }
    const { goTo } = setup(COMPANION, [split])
    await regenerate(user)
    await tick()
    await screen.findByText(/group changed/)
    act(() => goTo('a190', TRACKED))
    await screen.findByText("A190's summary.")
    expect(screen.queryByText(/group changed/)).not.toBeInTheDocument()
  })

  it("does not put a run's outcome on the page the admin moved to while it ran", async () => {
    const { goTo } = setup(COMPANION, [{ ...COMPANION, analysisAiProcessedAt: '2026-10-15 12:00:00' }])
    await regenerate(user)
    await screen.findByText(/Regenerating/)
    act(() => goTo('a190', TRACKED))
    await screen.findByText("A190's summary.")
    await tick()
    await tick()
    expect(screen.queryByText(/Re-analyzed A190/)).not.toBeInTheDocument()
  })
})

describe('a group change that leaves the page with no analysis', () => {
  it("still says the group changed, where the analysis box would have been", async () => {
    // After the split the page is an unanalyzed stub: nothing to put the notice beside.
    const split = { ...COMPANION, analysisBillId: '42', analysisBillNumber: 'S1713' }
    const stub = { tenantSummary: null, tags: [], relevanceScore: null, aiProcessedAt: null, matchType: null, analysisBillId: '42', analysisBillExternalId: 'legiscan:42', analysisBillNumber: 'S1713', analysisAiProcessedAt: null }
    setup(COMPANION, [split], stub)
    await regenerate(user)
    await tick()
    expect(await screen.findByText(/group changed while A190 was being re-analyzed, so this page now shows a different bill's summary/)).toBeInTheDocument()
    expect(screen.queryByText("A190's summary.")).not.toBeInTheDocument()
  })

  it("shows it once, beside the analysis, when the page still has one", async () => {
    const split = { ...COMPANION, analysisBillId: '42', analysisBillNumber: 'S1713' }
    setup(COMPANION, [split])
    await regenerate(user)
    await tick()
    expect(await screen.findAllByText(/group changed while A190/)).toHaveLength(1)
  })
})
