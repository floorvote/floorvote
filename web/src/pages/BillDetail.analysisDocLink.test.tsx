import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// The "based on text" link above a bill's summary opens the document the shown
// analysis read (#601). On a companion group's page that analysis may be another
// member's (#554), so the link names and opens that member's document, not the
// page bill's own last-analyzed one. Invented bills A100 and S200. The
// scaffolding is BillDetail.claimLinks.test.tsx's.

const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' } as {
    state: unknown; pathname: string; hash: string; search: string
  },
  loaderData: null as unknown,
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
vi.mock('../lib/scrollUtils', () => ({ getScrollContainer: () => ({ scrollTo: vi.fn(), scrollTop: 0 }) }))
vi.mock('../components/RichTextEditor', () => ({ RichTextEditor: () => null }))
vi.mock('../components/PositionBadge', () => ({ PositionBadge: ({ position }: { position: string }) => <span>{position}</span> }))
vi.mock('../context/DemoContext', () => ({ useDemo: () => ({ demoLocked: false }) }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'member', subtitle: null, canVote: true }, loading: false }),
}))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({ useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn() }) }))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

// ── Fixtures ────────────────────────────────────────────────────────────────

const A_HTML = '<!DOCTYPE html><html><body><p>A100 text.</p></body></html>'
const S_HTML = '<!DOCTYPE html><html><body><p>S200 text.</p></body></html>'
const TEXT_A = { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: null, altStateLink: null }
const DOC_S = { docId: '9002', type: 'Engrossed', date: '2026-02-02', mime: 'text/html', stateLink: null, altStateLink: null }

// Page 42 is A100, showing its own analysis, which read its own Introduced text.
const BILL = {
  id: '42', externalId: 'legiscan:100', billNumber: 'A100', title: 'Drop Boxes', state: 'RI', status: 'Introduced',
  statusDate: null, session: '2025-2026', sessionId: '1', sessionSlug: '2025-2026', yearStart: 2025, yearEnd: 2026,
  description: null, billType: null, body: null, currentBody: null, abstract: null, stateLink: null, stateUrl: null,
  url: null, legiscanUrl: null, committee: null, referrals: [],
  tenantSummary: 'A summary.', tags: [], relevanceScore: 7, priority: null, textR2Key: 'bills/100.html',
  sponsor: null, sponsorParty: null, sponsorUrl: null, coSponsors: [], lastAction: null, lastActionDate: null,
  history: [], voteSummary: [], subjects: [], relatedBillIds: [], companionBillIds: [],
  texts: [TEXT_A], calendar: [], supplements: [], amendments: [], customFieldValues: {},
  matchType: 'keyword' as const, isDraft: false, draftText: null,
  createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00', centralSyncedAt: null,
  aiProcessedAt: '2026-01-01 10:00:00', aiSkipReason: null,
  analysisBillId: '42', analysisBillExternalId: 'legiscan:100', analysisBillNumber: 'A100',
  analysisAiProcessedAt: '2026-01-01 10:00:00', analysisAiSkipReason: null, analysisTextStatus: 'in_r2',
  analysisLastAiTextDocId: '9001', analysisLastAiText: TEXT_A,
  claimLinksEnabled: false, claimSources: null,
  lastAiTextDocId: '9001', textStatus: 'in_r2' as const, myVote: null, myNote: null, priorityMeta: null, position: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 }, memberVotes: [], comments: [], commentsTotal: 0,
}

// Page 42 is A100, a pulled companion: the group shows S200's analysis, which
// read S200's Engrossed text. A100's own last analysis read its Introduced one.
const BORROWED = {
  matchType: null, aiProcessedAt: '2026-01-03 10:00:00', tenantSummary: "S200's summary.",
  analysisBillId: 's200', analysisBillExternalId: 'legiscan:200', analysisBillNumber: 'S200',
  analysisAiProcessedAt: '2026-01-02 10:00:00',
  analysisLastAiTextDocId: '9002', analysisLastAiText: DOC_S,
}

const CONFIG = { associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'], states: ['RI'], instanceDomains: {}, orgNoun: 'association' }

let fetched: string[]
function setup(page: Record<string, unknown> = {}, drop: string[] = []) {
  const bill: Record<string, unknown> = { ...BILL, ...page }
  for (const k of drop) delete bill[k]
  routerMock.loaderData = bill
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path.startsWith('/bills/')) return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles' || path === '/users') return [] as never
    return {} as never
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    fetched.push(url)
    const html = url === '/api/bills/42/text/9001' ? A_HTML : url === '/api/bills/s200/text/9002' ? S_HTML : null
    if (html !== null) return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

const basedOn = () => screen.queryByText(/based on text/)
const textChip = () => screen.getByTitle('Show this bill text version')

beforeEach(() => {
  vi.restoreAllMocks()
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
  fetched = []
  URL.createObjectURL = vi.fn(() => 'blob:test/1')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("the analysis document link on a companion's page showing another member's analysis", () => {
  it("names the analyzed member's document, with that member's bill number", async () => {
    setup(BORROWED)
    await screen.findByText("S200's summary.")
    expect(basedOn()).toBeInTheDocument()
    const chip = textChip()
    expect(chip).toHaveTextContent('S200')
    expect(chip).toHaveTextContent('Engrossed')
    expect(chip).not.toHaveTextContent('Introduced')
  })

  it("opens the analyzed member's document, never the page bill's own text", async () => {
    const user = userEvent.setup()
    setup(BORROWED)
    await screen.findByText("S200's summary.")
    await user.click(textChip())
    await waitFor(() => expect(fetched).toContain('/api/bills/s200/text/9002'))
    expect(fetched.filter(u => u.startsWith('/api/bills/42/text/'))).toEqual([])
  })

  it("opens the analyzed member's document when the page bill has no texts of its own", async () => {
    const user = userEvent.setup()
    setup({ ...BORROWED, texts: [], textR2Key: null, lastAiTextDocId: null })
    await screen.findByText("S200's summary.")
    await user.click(textChip())
    await waitFor(() => expect(fetched).toContain('/api/bills/s200/text/9002'))
  })

  it("opens the analyzed member's document again when the link is clicked again", async () => {
    const user = userEvent.setup()
    setup(BORROWED)
    await screen.findByText("S200's summary.")
    await user.click(textChip())
    await waitFor(() => expect(fetched).toContain('/api/bills/s200/text/9002'))
    await user.click(textChip())
    expect(fetched.filter(u => u.startsWith('/api/bills/42/text/'))).toEqual([])
  })

  it("shows no link when the analyzed member's document is gone, though the page bill's own is listed", async () => {
    setup({ ...BORROWED, analysisLastAiTextDocId: '9999', analysisLastAiText: null })
    await screen.findByText("S200's summary.")
    expect(basedOn()).toBeNull()
  })

  it("shows no link when the analyzed member has no recorded document, though the page bill's own is listed", async () => {
    setup({ ...BORROWED, analysisLastAiTextDocId: null, analysisLastAiText: null })
    await screen.findByText("S200's summary.")
    expect(basedOn()).toBeNull()
  })
})

describe('the analysis document link where the page shows its own analysis', () => {
  it("is unchanged for a bill in no group: its own document, opened from its own texts", async () => {
    const user = userEvent.setup()
    setup()
    await screen.findByText('A summary.')
    expect(textChip()).toHaveTextContent('Introduced')
    expect(textChip()).not.toHaveTextContent('A100')
    await user.click(textChip())
    await waitFor(() => expect(fetched).toContain('/api/bills/42/text/9001'))
  })

  it("is unchanged on a tracked bill's own page, though a companion is grouped with it", async () => {
    const user = userEvent.setup()
    setup({ groupBills: [{ id: '42', billNumber: 'A100' }, { id: 's200', billNumber: 'S200' }] })
    await screen.findByText('A summary.')
    expect(textChip()).toHaveTextContent('Introduced')
    await user.click(textChip())
    await waitFor(() => expect(fetched).toContain('/api/bills/42/text/9001'))
  })

  it('shows no link for a bill with no analysis document', async () => {
    setup({ lastAiTextDocId: null, analysisLastAiTextDocId: null, analysisLastAiText: null })
    await screen.findByText('A summary.')
    expect(basedOn()).toBeNull()
  })

  it("shows no link when the bill's recorded document is not in its text list", async () => {
    setup({ lastAiTextDocId: '9999', analysisLastAiTextDocId: '9999', analysisLastAiText: null })
    await screen.findByText('A summary.')
    expect(basedOn()).toBeNull()
  })

  it('shows no link and no summary area for a bill that was never analyzed', async () => {
    setup({ tenantSummary: null, aiProcessedAt: null, analysisAiProcessedAt: null, lastAiTextDocId: null, analysisLastAiTextDocId: null, analysisLastAiText: null })
    await screen.findAllByText(/A100/)
    expect(screen.queryByText('AI Summary')).toBeNull()
    expect(basedOn()).toBeNull()
  })
})

describe("the analysis document link against a server that predates the analysis document fields", () => {
  const OLD = ['analysisLastAiTextDocId', 'analysisLastAiText']

  it("falls back to the page bill's own document, as before", async () => {
    const user = userEvent.setup()
    setup({}, OLD)
    await screen.findByText('A summary.')
    expect(textChip()).toHaveTextContent('Introduced')
    await user.click(textChip())
    await waitFor(() => expect(fetched).toContain('/api/bills/42/text/9001'))
  })

  it('falls back with no analysis bill fields at all', async () => {
    setup({}, [...OLD, 'analysisBillId', 'analysisBillExternalId', 'analysisBillNumber', 'analysisAiProcessedAt', 'analysisAiSkipReason', 'analysisTextStatus'])
    await screen.findByText('A summary.')
    expect(textChip()).toHaveTextContent('Introduced')
  })

  it('shows no link when the old response has no document recorded', async () => {
    setup({ lastAiTextDocId: null }, OLD)
    await screen.findByText('A summary.')
    expect(basedOn()).toBeNull()
  })
})
