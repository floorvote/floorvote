import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'
import { billHtmlToText } from '../../../shared/billHtmlToText'
import { PASSAGE_ID } from '../lib/claimLinks'

// Bill texts on a companion's page (#712): the shared summary and the Bill texts
// list agree on the text the summary came from. The header names it with the
// analysis bill's badge and chip, the list has one row per group bill (each
// headed once by its badge, versions newest first, rows by newest version), and
// the header chip and claims select a version in its own bill's row. Invented
// bills A100 (the analysis bill), S200, and H300. The scaffolding is
// BillDetail.analysisDocLink.test.tsx's.

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

const A_HTML = '<!DOCTYPE html><html><body><p>A100. Section 1.</p><p>Each county shall have a drop box.</p></body></html>'
const matched = 'Each county shall have a drop box.'
const start = billHtmlToText(A_HTML).indexOf(matched)
const html = (name: string) => `<!DOCTYPE html><html><body><p>${name} text.</p></body></html>`
const HTML_BY_URL: Record<string, string> = {
  '/api/bills/42/text/9001': html('A100 introduced'),
  '/api/bills/42/text/9003': A_HTML,
  '/api/bills/s200/text/9002': html('S200 engrossed'),
  '/api/bills/s200/text/9004': html('S200 amended'),
  '/api/bills/h300/text/9005': html('H300 introduced'),
}

const v = (docId: string, type: string, date: string) => ({ docId, type, date, mime: 'text/html', stateLink: null, altStateLink: null })
const A1 = v('9001', 'Introduced', '2026-01-13')
const A3 = v('9003', 'Chaptered', '2026-10-15')
const S1 = v('9002', 'Engrossed', '2026-02-02')
const S2 = v('9004', 'Amended', '2026-06-29')
const H1 = v('9005', 'Reprint', '2026-04-04')

const link = (billId: string, billNumber: string) => ({ billId, billNumber, state: 'RI', sessionSlug: '2025-2026' })
const A_ROW = { ...link('42', 'A100'), texts: [A3, A1] }
const S_ROW = { ...link('s200', 'S200'), texts: [S2, S1] }
const H_ROW = { ...link('h300', 'H300'), texts: [H1] }

const SUMMARY = '- Requires a drop box in each county.'
const CLAIM = 'Requires a drop box in each county.'

// A100, the analysis bill, on its own page: its analysis read its Chaptered text.
const A_PAGE = {
  id: '42', externalId: 'legiscan:100', billNumber: 'A100', title: 'Drop Boxes', state: 'RI', status: 'Introduced',
  statusDate: null, session: '2025-2026', sessionId: '1', sessionSlug: '2025-2026', yearStart: 2025, yearEnd: 2026,
  description: null, billType: null, body: null, currentBody: null, abstract: null, stateLink: null, stateUrl: null,
  url: null, legiscanUrl: null, committee: null, referrals: [],
  tenantSummary: SUMMARY, tags: [], relevanceScore: 7, priority: null, textR2Key: 'bills/100.html',
  sponsor: null, sponsorParty: null, sponsorUrl: null, coSponsors: [], lastAction: null, lastActionDate: null,
  history: [], voteSummary: [], subjects: [], relatedBillIds: [], companionBillIds: [],
  texts: [A3, A1], calendar: [], supplements: [], amendments: [], customFieldValues: {},
  matchType: 'keyword' as const, isDraft: false, draftText: null,
  createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00', centralSyncedAt: null,
  aiProcessedAt: '2026-10-16 10:00:00', aiSkipReason: null,
  analysisBillId: '42', analysisBillExternalId: 'legiscan:100', analysisBillNumber: 'A100',
  analysisAiProcessedAt: '2026-10-16 10:00:00', analysisAiSkipReason: null, analysisTextStatus: 'in_r2',
  analysisLastAiTextDocId: '9003', analysisLastAiText: A3,
  claimLinksEnabled: true,
  claimSources: { billId: '42', document: A3, items: [{ claim: CLAIM, status: 'exact', quoteAt: { start, end: start + matched.length }, matched }] },
  lastAiTextDocId: '9003', textStatus: 'in_r2' as const, myVote: null, myNote: null, priorityMeta: null, position: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 }, memberVotes: [], comments: [], commentsTotal: 0,
  groupBills: [link('42', 'A100'), link('s200', 'S200')],
  groupTexts: [A_ROW, S_ROW],
}

// S200, its companion, on its page: the group's summary is A100's. S200's own last analysis read an older text.
const S_PAGE = {
  ...A_PAGE,
  id: 's200', externalId: 'legiscan:200', billNumber: 'S200', title: 'Drop Box Companion', textR2Key: 'bills/200.html',
  texts: [S2, S1], matchType: null, lastAiTextDocId: '9002',
  groupBills: [link('s200', 'S200'), link('42', 'A100')],
  groupTexts: [S_ROW, A_ROW],
}

const CONFIG = { associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'], states: ['RI'], instanceDomains: {}, orgNoun: 'association' }

let fetched: string[]
let blobs: Blob[]
function setup(page: Record<string, unknown> = S_PAGE, drop: string[] = []) {
  const bill: Record<string, unknown> = { ...page }
  for (const k of drop) delete bill[k]
  routerMock.params = { billId: String(bill.id) }
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
    const body = HTML_BY_URL[url]
    if (body !== undefined) return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

/** The AI summary's header line: the label, what it is based on, the badge and chip. */
const summaryHeader = async () => (await screen.findByText('AI Summary')).parentElement as HTMLElement
const headerChip = () => screen.getByTitle('Show this bill text version')
const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /^Bill texts/ }))
}
const rows = () => screen.queryAllByRole('group', { name: /bill texts$/ })
const rowFor = (billNumber: string) => screen.getByRole('group', { name: `${billNumber} bill texts` })
const chipLabels = (el: HTMLElement) => within(el).getAllByRole('button').map(b => b.textContent ?? '')
/** Every version chip in the Bill texts list, whatever its layout. */
const allChips = () => screen.queryAllByRole('button').filter(b => b.hasAttribute('aria-pressed'))
const pressed = () => allChips().filter(b => b.getAttribute('aria-pressed') === 'true')
const passageFrame = async () => {
  await waitFor(() => expect((screen.getByTitle(/^Bill text/) as HTMLIFrameElement).getAttribute('src') ?? '').toMatch(/^blob:/), { timeout: 3000 })
  return screen.getByTitle(/^Bill text/) as HTMLIFrameElement
}
const highlighted = async () => {
  const doc = new DOMParser().parseFromString(await blobs[blobs.length - 1].text(), 'text/html')
  return doc.getElementById(PASSAGE_ID)?.textContent ?? null
}

beforeEach(() => {
  vi.restoreAllMocks()
  routerMock.location = { state: null, pathname: '/bills/s200', hash: '', search: '' }
  fetched = []
  blobs = []
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return `blob:test/${blobs.length}` })
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("the summary header on a companion's page names the summary's true source", () => {
  it("reads 'based on', the analysis bill's badge, and that bill's last-analyzed version", async () => {
    setup()
    const header = await summaryHeader()
    expect(header).toHaveTextContent(/based on/i)
    expect(within(header).getAllByText('A100')).toHaveLength(1)
    expect(headerChip()).toHaveTextContent('Chaptered')
    expect(headerChip()).toHaveTextContent('2026-10-15')
  })

  it("shows the analysis bill's version, never the page bill's own last-analyzed one", async () => {
    setup()
    await summaryHeader()
    expect(headerChip()).not.toHaveTextContent('Engrossed')
    expect(within(await summaryHeader()).queryByText('S200')).toBeNull()
  })

  it('puts the bill number in the badge, not the chip', async () => {
    setup()
    await summaryHeader()
    expect(headerChip()).not.toHaveTextContent('A100')
  })

  it("shows no 'summary from' line any more", async () => {
    setup()
    await summaryHeader()
    expect(screen.queryByText(/identical companion/)).toBeNull()
    expect(screen.queryByText(/Summary of/)).toBeNull()
  })

  it("still says whose summary it is when the analysis bill's document is gone, with no chip", async () => {
    setup({ ...S_PAGE, analysisLastAiTextDocId: '9999', analysisLastAiText: null, claimSources: null })
    const header = await summaryHeader()
    expect(within(header).getByText('A100')).toBeInTheDocument()
    expect(header).toHaveTextContent(/based on/i)
    expect(screen.queryByTitle('Show this bill text version')).toBeNull()
  })
})

describe("the summary header on the analysis bill's own page", () => {
  it('shows no badge, as today', async () => {
    setup(A_PAGE)
    const header = await summaryHeader()
    expect(headerChip()).toHaveTextContent('Chaptered')
    expect(within(header).queryByText('A100')).toBeNull()
  })

  it('shows no chip or label for a document that is gone, and no badge', async () => {
    setup({ ...A_PAGE, analysisLastAiTextDocId: '9999', analysisLastAiText: null })
    const header = await summaryHeader()
    expect(within(header).queryByText('A100')).toBeNull()
    expect(header).not.toHaveTextContent(/based on/i)
  })
})

describe('Bill texts on a grouped bill: one row per bill', () => {
  it("heads each bill's row once with its badge, and lists its versions newest first", async () => {
    const user = userEvent.setup()
    setup()
    await openPanel(user)
    expect(rows()).toHaveLength(2)
    for (const [number, labels] of [['A100', ['Chaptered', 'Introduced']], ['S200', ['Amended', 'Engrossed']]] as const) {
      const row = rowFor(number)
      expect(within(row).getAllByText(number)).toHaveLength(1)
      expect(chipLabels(row).map(l => l.replace(/\d{4}-\d{2}-\d{2}$/, ''))).toEqual(labels)
    }
  })

  it("orders the rows by each bill's newest version, newest first", async () => {
    const user = userEvent.setup()
    setup()
    await openPanel(user)
    expect(rows().map(r => r.getAttribute('aria-label'))).toEqual(['A100 bill texts', 'S200 bill texts'])
  })

  it('orders the rows the same on every page in the group', async () => {
    const user = userEvent.setup()
    const first = setup(S_PAGE)
    await openPanel(user)
    const onS = rows().map(r => r.getAttribute('aria-label'))
    first.unmount()
    setup(A_PAGE)
    await openPanel(user)
    expect(rows().map(r => r.getAttribute('aria-label'))).toEqual(onS)
  })

  it('lists a group of three, ordered by newest version', async () => {
    const user = userEvent.setup()
    setup({ ...S_PAGE, groupBills: [link('s200', 'S200'), link('42', 'A100'), link('h300', 'H300')], groupTexts: [S_ROW, H_ROW, A_ROW] })
    await openPanel(user)
    expect(rows().map(r => r.getAttribute('aria-label'))).toEqual(['A100 bill texts', 'S200 bill texts', 'H300 bill texts'])
    expect(allChips()).toHaveLength(5)
  })

  it('lets a row wrap, so it fits at 390px wide', async () => {
    const user = userEvent.setup()
    setup()
    await openPanel(user)
    for (const row of rows()) expect(row.style.flexWrap).toBe('wrap')
  })

  it("opens on the page bill's newest version", async () => {
    const user = userEvent.setup()
    setup()
    await openPanel(user)
    await waitFor(() => expect(fetched).toContain('/api/bills/s200/text/9004'))
    expect(pressed()).toHaveLength(1)
    expect(within(rowFor('S200')).getByRole('button', { pressed: true })).toHaveTextContent('Amended')
  })

  it("lists a companion's versions when the page bill has none of its own, opening on the first row's newest", async () => {
    const user = userEvent.setup()
    setup({ ...S_PAGE, texts: [], textR2Key: null, groupTexts: [A_ROW] })
    await openPanel(user)
    expect(rows()).toHaveLength(1)
    expect(within(rowFor('A100')).getByRole('button', { pressed: true })).toHaveTextContent('Chaptered')
  })

  it('selects a version of another bill in its row and shows that bill\'s text', async () => {
    const user = userEvent.setup()
    setup()
    await openPanel(user)
    await user.click(within(rowFor('A100')).getByRole('button', { name: /Introduced/ }))
    await waitFor(() => expect(fetched).toContain('/api/bills/42/text/9001'))
    expect(pressed()).toHaveLength(1)
    expect(within(rowFor('A100')).getByRole('button', { pressed: true })).toHaveTextContent('Introduced')
    expect(fetched.filter(u => u.startsWith('/api/bills/s200/text/9001'))).toEqual([])
  })
})

describe('Bill texts on a bill in no group', () => {
  const SOLO = { ...A_PAGE, groupBills: [link('42', 'A100')], groupTexts: [A_ROW] }

  it('shows its versions with no badge and no rows, as today', async () => {
    const user = userEvent.setup()
    setup(SOLO)
    await openPanel(user)
    expect(rows()).toHaveLength(0)
    expect(allChips().map(b => b.textContent)).toEqual(['Chaptered2026-10-15', 'Introduced2026-01-13'])
    expect(screen.queryByRole('group', { name: /bill texts/ })).toBeNull()
  })

  it('shows no badge for a bill with no group fields at all', async () => {
    const user = userEvent.setup()
    setup({ ...A_PAGE }, ['groupBills', 'groupTexts'])
    await openPanel(user)
    expect(rows()).toHaveLength(0)
    expect(allChips()).toHaveLength(2)
  })
})

describe("selecting in place: the header chip and a claim choose a version in its own bill's row", () => {
  it("selects the analysis bill's version in its row when the header chip is clicked, appending nothing", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(headerChip())
    await waitFor(() => expect(fetched).toContain('/api/bills/42/text/9003'))
    expect(fetched.filter(u => u.startsWith('/api/bills/s200/text/9003'))).toEqual([])
    expect(allChips()).toHaveLength(4)
    expect(pressed()).toHaveLength(1)
    expect(within(rowFor('A100')).getByRole('button', { pressed: true })).toHaveTextContent('Chaptered')
  })

  it('selects it again after the reader picked another version', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(headerChip())
    await waitFor(() => expect(within(rowFor('A100')).getByRole('button', { pressed: true })).toHaveTextContent('Chaptered'))
    await user.click(within(rowFor('S200')).getByRole('button', { name: /Engrossed/ }))
    expect(within(rowFor('S200')).getByRole('button', { pressed: true })).toHaveTextContent('Engrossed')
    // The page clears its request after a moment, so a later click is a new one.
    await new Promise(r => setTimeout(r, 150))
    await user.click(headerChip())
    await waitFor(() => expect(within(rowFor('A100')).getByRole('button', { pressed: true })).toHaveTextContent('Chaptered'))
    expect(pressed()).toHaveLength(1)
  })

  it("opens the claim's document in its row, highlighted at the passage, appending no chip", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await screen.findByRole('link', { name: CLAIM }))
    await passageFrame()
    expect(await highlighted()).toBe(matched)
    expect(fetched).toContain('/api/bills/42/text/9003')
    expect(fetched.filter(u => u.startsWith('/api/bills/s200/text/9003'))).toEqual([])
    expect(allChips()).toHaveLength(4)
    expect(within(rowFor('A100')).getByRole('button', { pressed: true })).toHaveTextContent('Chaptered')
    expect(pressed()).toHaveLength(1)
  })

  it('opens a claim on the analysis bill\'s own page in its own row too', async () => {
    const user = userEvent.setup()
    setup(A_PAGE)
    await user.click(await screen.findByRole('link', { name: CLAIM }))
    await passageFrame()
    expect(await highlighted()).toBe(matched)
    expect(allChips()).toHaveLength(4)
  })

  it("shows the claim's document in its row when the page bill has no texts of its own", async () => {
    const user = userEvent.setup()
    setup({ ...S_PAGE, texts: [], textR2Key: null, groupTexts: [A_ROW] })
    await user.click(await screen.findByRole('link', { name: CLAIM }))
    await passageFrame()
    expect(await highlighted()).toBe(matched)
    expect(allChips()).toHaveLength(2)
  })
})

describe('against a server that sends no group texts', () => {
  const OLD = ['groupTexts']

  it("lists the page bill's own versions, with no rows", async () => {
    const user = userEvent.setup()
    setup(S_PAGE, OLD)
    await openPanel(user)
    expect(rows()).toHaveLength(0)
    expect(allChips().map(b => b.textContent)).toEqual(['Amended2026-06-29', 'Engrossed2026-02-02'])
  })

  it("still opens the analysis bill's document from the header chip, beside the page bill's own versions", async () => {
    const user = userEvent.setup()
    setup(S_PAGE, OLD)
    await user.click(headerChip())
    await waitFor(() => expect(fetched).toContain('/api/bills/42/text/9003'))
    expect(fetched.filter(u => u.startsWith('/api/bills/s200/text/9003'))).toEqual([])
    expect(allChips()).toHaveLength(3)
  })

  it("still opens a claim's document beside the page bill's own versions", async () => {
    const user = userEvent.setup()
    setup(S_PAGE, OLD)
    await user.click(await screen.findByRole('link', { name: CLAIM }))
    await passageFrame()
    expect(await highlighted()).toBe(matched)
    expect(allChips()).toHaveLength(3)
  })

  it('still names the source in the header, with the badge', async () => {
    setup(S_PAGE, [...OLD, 'groupBills'])
    const header = await summaryHeader()
    expect(within(header).getByText('A100')).toBeInTheDocument()
    expect(headerChip()).toHaveTextContent('Chaptered')
  })
})
