import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import { MarkdownSummary } from '../components/MarkdownSummary'
import * as api from '../lib/api'
import { billHtmlToText } from '../../../shared/billHtmlToText'
import { PASSAGE_ID } from '../lib/claimLinks'
import { color, fontSize } from '../styles/tokens'

// Claim links on an HTML bill's summary (#571). A claim's own text links to the
// passage behind it, which opens in the bill text panel, highlighted. On a
// companion group's page the summary may be another member's (#554, #559): its
// links open that member's document, never the page bill's own text, and the
// summary says whose it is. Invented bills A100 and S200, whose texts differ.
// The scaffolding is BillDetail.regenerate.test.tsx's.

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

const A_HTML = '<!DOCTYPE html><html><body><p>A100. Section 1.</p><p>Each county shall have a drop box.</p><p>Boxes are emptied daily.</p></body></html>'
// S200's text differs from A100's: other front matter, and its passages are worded differently.
const S_HTML = '<!DOCTYPE html><html><body><p>S200. Section 1.</p><p>Front matter only S200 has.</p><p>Each county shall have one drop box, emptied daily.</p><p>Two employees empty each box.</p></body></html>'

function passageIn(html: string, text: string) {
  const t = billHtmlToText(html)
  const start = t.indexOf(text)
  if (start === -1) throw new Error('fixture')
  return { quoteAt: { start, end: start + text.length }, matched: text }
}

const SUMMARY = '- Requires a drop box in each county.\n- Boxes are emptied by two employees.\n- Something the text never says.'
const TEXT_A = { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: null, altStateLink: null }
const DOC_S = { docId: '9002', type: 'Engrossed', date: '2026-01-02', mime: 'text/html', stateLink: null, altStateLink: null }

const OWN_SOURCES = {
  billId: '42',
  document: TEXT_A,
  items: [
    { claim: 'Requires a drop box in each county.', status: 'exact', ...passageIn(A_HTML, 'Each county shall have a drop box.') },
    { claim: 'Boxes are emptied by two employees.', status: 'fuzzy', ...passageIn(A_HTML, 'Boxes are emptied daily.') },
    { claim: 'Something the text never says.', status: 'ungrounded' },
  ],
}
const S_SOURCES = {
  billId: 's200',
  document: DOC_S,
  items: [
    { claim: 'Requires a drop box in each county.', status: 'normalized', ...passageIn(S_HTML, 'Each county shall have one drop box, emptied daily.') },
    { claim: 'Boxes are emptied by two employees.', status: 'anchored', ...passageIn(S_HTML, 'Two employees empty each box.') },
    { claim: 'Something the text never says.', status: 'ungrounded' },
  ],
}

// Page 42 is A100, showing its own analysis.
const BILL = {
  id: '42', externalId: 'legiscan:100', billNumber: 'A100', title: 'Drop Boxes', state: 'RI', status: 'Introduced',
  statusDate: null, session: '2025-2026', sessionId: '1', sessionSlug: '2025-2026', yearStart: 2025, yearEnd: 2026,
  description: null, billType: null, body: null, currentBody: null, abstract: null, stateLink: null, stateUrl: null,
  url: null, legiscanUrl: null, committee: null, referrals: [],
  tenantSummary: SUMMARY, tags: [], relevanceScore: 7, priority: null, textR2Key: 'bills/100.html',
  sponsor: null, sponsorParty: null, sponsorUrl: null, coSponsors: [], lastAction: null, lastActionDate: null,
  history: [], voteSummary: [], subjects: [], relatedBillIds: [], companionBillIds: [],
  texts: [TEXT_A], calendar: [], supplements: [], amendments: [], customFieldValues: {},
  matchType: 'keyword' as const, isDraft: false, draftText: null,
  createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00', centralSyncedAt: null,
  aiProcessedAt: '2026-01-01 10:00:00', aiSkipReason: null,
  analysisBillId: '42', analysisBillExternalId: 'legiscan:100', analysisBillNumber: 'A100',
  analysisAiProcessedAt: '2026-01-01 10:00:00', analysisAiSkipReason: null, analysisTextStatus: 'in_r2',
  claimLinksEnabled: true, claimSources: OWN_SOURCES,
  lastAiTextDocId: null, textStatus: 'in_r2' as const, myVote: null, myNote: null, priorityMeta: null, position: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 }, memberVotes: [], comments: [], commentsTotal: 0,
}

// Page 42 is A100, a pulled companion: the group shows S200's analysis.
const BORROWED = {
  matchType: null, aiProcessedAt: '2026-01-03 10:00:00',
  analysisBillId: 's200', analysisBillExternalId: 'legiscan:200', analysisBillNumber: 'S200',
  analysisAiProcessedAt: '2026-01-02 10:00:00', claimSources: S_SOURCES,
}

const CONFIG = { associationName: 'Test Assoc', positionVocabulary: ['support', 'oppose', 'neutral'], states: ['RI'], instanceDomains: {}, orgNoun: 'association' }

let fetched: string[]
let blobs: Blob[]
function setup(page: Record<string, unknown> = {}) {
  const bill = { ...BILL, ...page }
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

const summaryBox = async () => {
  await screen.findByText('AI Summary')
  return document.querySelector('.markdown-summary') as HTMLElement
}
const claimLink = (name: string) => screen.findByRole('link', { name })
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
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
  fetched = []
  blobs = []
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return `blob:test/${blobs.length}` })
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('claim links on a bill showing its own analysis', () => {
  it('links each resolved claim\'s own text, and leaves an ungrounded claim as plain text', async () => {
    setup()
    expect(await claimLink('Requires a drop box in each county.')).toHaveAttribute('href')
    expect(await claimLink('Boxes are emptied by two employees.')).toBeInTheDocument()
    const box = await summaryBox()
    expect(box.textContent).toContain('Something the text never says.')
    expect(screen.queryByRole('link', { name: 'Something the text never says.' })).toBeNull()
  })

  it('opens the bill text on the pinned document, highlighted at the passage, when a claim is clicked', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await claimLink('Requires a drop box in each county.'))
    await passageFrame()
    expect(fetched).toContain('/api/bills/42/text/9001')
    expect(await highlighted()).toBe('Each county shall have a drop box.')
  })

  it('opens a different passage for a different claim', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await claimLink('Boxes are emptied by two employees.'))
    await passageFrame()
    expect(await highlighted()).toBe('Boxes are emptied daily.')
  })

  it('activates with Enter from the keyboard, and moves focus to the highlighted passage', async () => {
    const user = userEvent.setup()
    setup()
    const link = await claimLink('Requires a drop box in each county.')
    link.focus()
    expect(link).toHaveFocus()
    await user.keyboard('{Enter}')
    const f = await passageFrame()
    fireEvent.load(f)
    expect(f).toHaveFocus()
    expect(f.getAttribute('src')).toMatch(new RegExp(`#${PASSAGE_ID}$`))
  })

  it('says nothing about whose summary it is', async () => {
    setup()
    await claimLink('Requires a drop box in each county.')
    expect(screen.queryByText(/Summary of/)).toBeNull()
  })

  it('renders no links when the pinned document is not in the bill\'s text list', async () => {
    setup({ claimSources: { ...OWN_SOURCES, document: { ...TEXT_A, docId: '9999' } } })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
  })

  it('renders no links when the server found the pinned document gone', async () => {
    setup({ claimSources: null })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
  })

  it('renders no links with the instance setting off, though claim sources are stored', async () => {
    setup({ claimLinksEnabled: false })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Boxes are emptied by two employees.' })).toBeNull()
  })
})

describe('claim links on a companion\'s page showing another member\'s analysis', () => {
  it('opens the analyzed member\'s document, highlighted at its passage, never the page bill\'s own text', async () => {
    const user = userEvent.setup()
    setup(BORROWED)
    await user.click(await claimLink('Requires a drop box in each county.'))
    await passageFrame()
    expect(fetched).toContain('/api/bills/s200/text/9002')
    expect(fetched.filter(u => u.startsWith('/api/bills/42/text/'))).toEqual([])
    expect(await highlighted()).toBe('Each county shall have one drop box, emptied daily.')
  })

  it('opens the second claim at its own passage in the analyzed member\'s document', async () => {
    const user = userEvent.setup()
    setup(BORROWED)
    await user.click(await claimLink('Boxes are emptied by two employees.'))
    await passageFrame()
    expect(await highlighted()).toBe('Two employees empty each box.')
  })

  it('labels the summary with the bill it is from, linking to that bill', async () => {
    setup(BORROWED)
    const link = await screen.findByRole('link', { name: 'S200' })
    expect(link).toHaveAttribute('href', '/bills/s200')
    expect(link.parentElement!.textContent).toBe('Summary of S200, this bill\'s identical companion')
  })

  it('opens the analyzed member\'s document even when the page bill has no texts of its own', async () => {
    const user = userEvent.setup()
    setup({ ...BORROWED, texts: [], textR2Key: null })
    await user.click(await claimLink('Requires a drop box in each county.'))
    await passageFrame()
    expect(fetched).toEqual(expect.arrayContaining(['/api/bills/s200/text/9002']))
    expect(await highlighted()).toBe('Each county shall have one drop box, emptied daily.')
  })

  it('renders no links, and no label, when the analyzed member\'s pinned document is gone', async () => {
    setup({ ...BORROWED, claimSources: null })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
    expect(screen.queryByText(/Summary of/)).toBeNull()
  })

  it('renders no links with the instance setting off', async () => {
    setup({ ...BORROWED, claimLinksEnabled: false })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
  })
})

describe('a summary without claim sources', () => {
  it('renders exactly as today, from a server with or without the field', async () => {
    const { unmount } = setup({ claimSources: undefined, claimLinksEnabled: undefined })
    const today = (await summaryBox()).outerHTML
    unmount()
    setup({ claimSources: null })
    expect((await summaryBox()).outerHTML).toBe(today)
    const plain = render(<MarkdownSummary fontSize={fontSize.base} color={color.textSlate} lineHeight={1.5}>{SUMMARY}</MarkdownSummary>)
    expect(plain.container.querySelector('.markdown-summary')!.innerHTML).toBe((await summaryBox()).innerHTML)
    expect(document.querySelectorAll('a[data-claim]')).toHaveLength(0)
  })
})
