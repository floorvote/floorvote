import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'
import { billHtmlToText } from '../../../shared/billHtmlToText'

// A bill text opened from a claim link must not follow the reader to the next
// bill (#734). The bill page does not remount when the route moves from one bill
// to another, so the claim-opened document and its extra chip have to be dropped
// when the bill changes. Invented bills A100 (with claim links), B300 (plain),
// and P500 (a pulled companion of S200). The scaffolding is
// BillDetail.claimLinks.test.tsx's.

const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '', key: 'k1' } as {
    state: unknown; pathname: string; hash: string; search: string; key: string
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
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'member', canVote: true }, loading: false }),
}))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({ useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn() }) }))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

// ── Fixtures ────────────────────────────────────────────────────────────────

const A_HTML = '<!DOCTYPE html><html><body><p>A100. Section 1.</p><p>Each county shall have a drop box.</p></body></html>'
const B1_HTML = '<!DOCTYPE html><html><body><p>B300 introduced text.</p></body></html>'
const B2_HTML = '<!DOCTYPE html><html><body><p>B300 engrossed text.</p></body></html>'
const P_HTML = '<!DOCTYPE html><html><body><p>P500 own text.</p></body></html>'
const S_HTML = '<!DOCTYPE html><html><body><p>S200 engrossed text.</p></body></html>'
const HTML_BY_URL: Record<string, string> = {
  '/api/bills/42/text/9001': A_HTML,
  '/api/bills/77/text/9101': B1_HTML,
  '/api/bills/77/text/9102': B2_HTML,
  '/api/bills/55/text/9201': P_HTML,
  '/api/bills/s200/text/9002': S_HTML,
}

const matched = 'Each county shall have a drop box.'
const start = billHtmlToText(A_HTML).indexOf(matched)
const SUMMARY = '- Requires a drop box in each county.'
const TEXT_A = { docId: '9001', type: 'Chaptered', date: '2026-03-03', mime: 'text/html', stateLink: null, altStateLink: null }
const TEXT_B1 = { docId: '9101', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: null, altStateLink: null }
const TEXT_B2 = { docId: '9102', type: 'Engrossed', date: '2026-02-02', mime: 'text/html', stateLink: null, altStateLink: null }
const TEXT_P = { docId: '9201', type: 'Introduced', date: '2026-01-05', mime: 'text/html', stateLink: null, altStateLink: null }
const DOC_S = { docId: '9002', type: 'Engrossed', date: '2026-02-03', mime: 'text/html', stateLink: null, altStateLink: null }

const BASE = {
  externalId: 'legiscan:100', state: 'RI', status: 'Introduced',
  statusDate: null, session: '2025-2026', sessionId: '1', sessionSlug: '2025-2026', yearStart: 2025, yearEnd: 2026,
  description: null, billType: null, body: null, currentBody: null, abstract: null, stateLink: null, stateUrl: null,
  url: null, legiscanUrl: null, committee: null, referrals: [],
  tags: [], relevanceScore: 7, priority: null,
  sponsor: null, sponsorParty: null, sponsorUrl: null, coSponsors: [], lastAction: null, lastActionDate: null,
  history: [], voteSummary: [], subjects: [], relatedBillIds: [], companionBillIds: [],
  calendar: [], supplements: [], amendments: [], customFieldValues: {},
  matchType: 'keyword' as const, isDraft: false, draftText: null,
  createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00', centralSyncedAt: null,
  aiProcessedAt: '2026-01-01 10:00:00', aiSkipReason: null,
  analysisAiProcessedAt: '2026-01-01 10:00:00', analysisAiSkipReason: null, analysisTextStatus: 'in_r2',
  textStatus: 'in_r2' as const, myVote: null, myNote: null, priorityMeta: null, position: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 }, memberVotes: [], comments: [], commentsTotal: 0,
}

// Bill A100: its summary has a claim link into its own Chaptered text.
const BILL_A = {
  ...BASE, id: '42', billNumber: 'A100', title: 'Drop Boxes', textR2Key: 'bills/100.html',
  tenantSummary: SUMMARY, texts: [TEXT_A],
  analysisBillId: '42', analysisBillExternalId: 'legiscan:100', analysisBillNumber: 'A100',
  claimLinksEnabled: true, lastAiTextDocId: '9001',
  claimSources: {
    billId: '42', document: TEXT_A,
    items: [{ claim: 'Requires a drop box in each county.', status: 'exact', quoteAt: { start, end: start + matched.length }, matched }],
  },
}
// Bill B300: two versions of its own, no claim sources.
const BILL_B = {
  ...BASE, id: '77', billNumber: 'B300', title: 'Ballot Curing', textR2Key: 'bills/300.html',
  tenantSummary: 'B summary.', texts: [TEXT_B1, TEXT_B2],
  analysisBillId: '77', analysisBillExternalId: 'legiscan:300', analysisBillNumber: 'B300',
  claimLinksEnabled: true, claimSources: null, lastAiTextDocId: '9101',
}
// Bill P500: a pulled companion showing S200's analysis, which read S200's Engrossed text (#601).
const BILL_P = {
  ...BASE, id: '55', billNumber: 'P500', title: 'Drop Box Companion', textR2Key: 'bills/500.html',
  tenantSummary: "S200's summary.", texts: [TEXT_P], matchType: null,
  analysisBillId: 's200', analysisBillExternalId: 'legiscan:200', analysisBillNumber: 'S200',
  analysisLastAiTextDocId: '9002', analysisLastAiText: DOC_S,
  claimLinksEnabled: false, claimSources: null, lastAiTextDocId: '9201',
}

const CONFIG = { associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'], states: ['RI'], instanceDomains: {}, orgNoun: 'association' }

const BILLS: Record<string, Record<string, unknown>> = { '42': BILL_A, '77': BILL_B, '55': BILL_P }

let fetched: string[]
function mountOn(id: string) {
  go(id)
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    const m = path.match(/^\/bills\/([^/?]+)/)
    if (m && BILLS[m[1]]) return BILLS[m[1]] as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles' || path === '/users') return [] as never
    return {} as never
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    fetched.push(url)
    const html = HTML_BY_URL[url]
    if (html !== undefined) return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}
let navCount = 0
function go(id: string, hash = '') {
  routerMock.params = { billId: id }
  routerMock.loaderData = BILLS[id]
  routerMock.location = { state: null, pathname: `/bills/${id}`, hash, search: '', key: `k${++navCount}` }
}
/** The data router re-renders the same BillDetail with the next bill's loader data. */
function moveTo(view: ReturnType<typeof render>, id: string, hash = '') {
  go(id, hash)
  view.rerender(<MemoryRouter><BillDetail /></MemoryRouter>)
}

const claimLink = () => screen.findByRole('link', { name: 'Requires a drop box in each county.' })
const frame = () => screen.getByTitle(/^Bill text/) as HTMLIFrameElement
/** The bill text panel's version chips (the "based on text" link above the summary is titled). */
const chipButtons = () => screen.queryAllByRole('button')
  .filter(b => !b.title && b.parentElement?.style.flexWrap === 'wrap' && b.parentElement.style.gap === '6px')
const chips = () => chipButtons().map(b => b.textContent ?? '')
const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /^Bill text/ }))
}
const shownText = async (text: string) => {
  await waitFor(() => expect(frame().getAttribute('srcdoc') ?? '').toContain(text))
}

beforeEach(() => {
  vi.restoreAllMocks()
  navCount = 0
  fetched = []
  URL.createObjectURL = vi.fn(() => 'blob:test/1')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('a claim-opened bill text when the page moves to another bill', () => {
  it("shows the next bill's own default text, not the claim's document", async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
    expect(chips()).toHaveLength(1)

    moveTo(view, '77')
    await screen.findByText('B summary.')
    await shownText('B300 introduced text.')
    expect(frame().getAttribute('srcdoc')).not.toContain('A100')
    expect(frame().title).toBe('Bill text')
  })

  it("lists only the next bill's versions, with no chip for the claim's document", async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))

    moveTo(view, '77')
    await screen.findByText('B summary.')
    await waitFor(() => expect(chips()).toHaveLength(2))
    expect(chips()[0]).toContain('Introduced')
    expect(chips()[1]).toContain('Engrossed')
    expect(chips().join(' ')).not.toMatch(/Chaptered|A100/)
  })

  it("selects the next bill's first version, which stays pickable", async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
    moveTo(view, '77')
    await screen.findByText('B summary.')
    await shownText('B300 introduced text.')
    await user.click(chipButtons().find(b => /Engrossed/.test(b.textContent ?? ''))!)
    await shownText('B300 engrossed text.')
  })

  it("does not fetch the claim's document for the next bill", async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
    fetched = []
    moveTo(view, '77')
    await screen.findByText('B summary.')
    await shownText('B300 introduced text.')
    expect(fetched.filter(u => u.includes('/9001'))).toEqual([])
  })

  it("going back to the first bill shows its default text, not the stale claim selection", async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
    moveTo(view, '77')
    await screen.findByText('B summary.')
    moveTo(view, '42')
    await screen.findByText('AI Summary')
    await shownText('A100. Section 1.')
    expect(frame().title).toBe('Bill text')
    expect(frame().getAttribute('srcdoc')).not.toContain('B300')
    expect(chips()).toHaveLength(1)
    expect(chips()[0]).toContain('Chaptered')
  })

  it('a claim clicked again after the move opens on the new bill as it should', async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
    moveTo(view, '77')
    await screen.findByText('B summary.')
    moveTo(view, '42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
    expect(frame().title).toMatch(/passage highlighted/)
  })

  it("a URL that names one of the next bill's texts opens that text, not the claim's", async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
    moveTo(view, '77', '#text-9102')
    await screen.findByText('B summary.')
    await shownText('B300 engrossed text.')
    expect(chips().join(' ')).not.toMatch(/Chaptered|A100/)
  })

  it("a companion's page after a claim shows its own text, and its analysis link still opens the analyzed member's", async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await user.click(await claimLink())
    await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
    moveTo(view, '55')
    await screen.findByText("S200's summary.")
    await shownText('P500 own text.')
    expect(chips()).toHaveLength(1)
    expect(chips().join(' ')).not.toMatch(/Chaptered|A100/)

    await user.click(screen.getByTitle('Show this bill text version'))
    await shownText('S200 engrossed text.')
    await waitFor(() => expect(chips()).toHaveLength(2))
    expect(chips()[1]).toContain('S200')
    expect(fetched).toContain('/api/bills/s200/text/9002')
  })
})

describe('moving between bills without opening a claim', () => {
  it("shows each bill's own text and chips, as before", async () => {
    const user = userEvent.setup()
    const view = mountOn('42')
    await screen.findByText('AI Summary')
    await openPanel(user)
    await shownText('A100. Section 1.')
    expect(chips()).toHaveLength(1)

    moveTo(view, '77')
    await screen.findByText('B summary.')
    await shownText('B300 introduced text.')
    expect(chips()).toHaveLength(2)
    expect(chips().join(' ')).not.toMatch(/Chaptered|A100/)

    await act(async () => { moveTo(view, '42') })
    await screen.findByText('AI Summary')
    await shownText('A100. Section 1.')
    expect(chips()).toHaveLength(1)
  })
})
