import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import { MarkdownSummary } from '../components/MarkdownSummary'
import * as api from '../lib/api'
import { color, fontSize } from '../styles/tokens'

// Claim links on a PDF bill's summary (#572). An `unverified` claim's own text
// links to its cited page, which opens in the bill text panel with the quote
// shown beside the link. On a companion group's page the summary may be another
// member's (#554, #559): its links open that member's PDF, never the page bill's
// own text, and the summary says whose it is. Invented bills A100 and S200,
// whose files differ. The scaffolding is BillDetail.claimLinks.test.tsx's.

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

const PDF_BYTES = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'
const A_HTML = '<!DOCTYPE html><html><body><p>A100. Section 1.</p><p>Only A100 has this paragraph.</p></body></html>'

const SUMMARY = '- Requires a drop box in each county.\n- Boxes are emptied by two employees.\n- Something the text never says.'
const PDF_A = { docId: '9101', type: 'Introduced', date: '2026-01-01', mime: 'application/pdf', stateLink: null, altStateLink: null }
const HTML_A = { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: null, altStateLink: null }
const PDF_S = { docId: '9102', type: 'Engrossed', date: '2026-01-02', mime: 'application/pdf', stateLink: null, altStateLink: null }

const Q1 = 'Each county shall have a drop box.'
const Q2 = 'Two employees shall empty each box.'
const OWN_SOURCES = {
  billId: '42',
  document: PDF_A,
  items: [
    { claim: 'Requires a drop box in each county.', status: 'unverified', quote: Q1, page: 7 },
    { claim: 'Boxes are emptied by two employees.', status: 'unverified', quote: Q2, page: null },
    { claim: 'Something the text never says.', status: 'ungrounded' },
  ],
}
const S_SOURCES = {
  billId: 's200',
  document: PDF_S,
  items: [
    { claim: 'Requires a drop box in each county.', status: 'unverified', quote: 'S200 words on drop boxes.', page: 12 },
    { claim: 'Boxes are emptied by two employees.', status: 'unverified', quote: 'S200 words on employees.', page: 0 },
    { claim: 'Something the text never says.', status: 'ungrounded' },
  ],
}

// Page 42 is A100, showing its own PDF analysis.
const BILL = {
  id: '42', externalId: 'legiscan:100', billNumber: 'A100', title: 'Drop Boxes', state: 'RI', status: 'Introduced',
  statusDate: null, session: '2025-2026', sessionId: '1', sessionSlug: '2025-2026', yearStart: 2025, yearEnd: 2026,
  description: null, billType: null, body: null, currentBody: null, abstract: null, stateLink: null, stateUrl: null,
  url: null, legiscanUrl: null, committee: null, referrals: [],
  tenantSummary: SUMMARY, tags: [], relevanceScore: 7, priority: null, textR2Key: 'bills/100.pdf',
  sponsor: null, sponsorParty: null, sponsorUrl: null, coSponsors: [], lastAction: null, lastActionDate: null,
  history: [], voteSummary: [], subjects: [], relatedBillIds: [], companionBillIds: [],
  texts: [PDF_A], calendar: [], supplements: [], amendments: [], customFieldValues: {},
  matchType: 'keyword' as const, isDraft: false, draftText: null,
  createdAt: '2025-01-01 00:00:00', updatedAt: '2025-01-01 00:00:00', centralSyncedAt: null,
  aiProcessedAt: '2026-01-01 10:00:00', aiSkipReason: null,
  analysisBillId: '42', analysisBillExternalId: 'legiscan:100', analysisBillNumber: 'A100',
  analysisAiProcessedAt: '2026-01-01 10:00:00', analysisAiSkipReason: null, analysisTextStatus: 'in_r2',
  claimLinksEnabled: true, claimSources: OWN_SOURCES,
  lastAiTextDocId: null, textStatus: 'in_r2' as const, myVote: null, myNote: null, priorityMeta: null, position: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 }, memberVotes: [], comments: [], commentsTotal: 0,
}

// Page 42 is A100, a pulled companion whose own file is HTML: the group shows S200's PDF analysis.
const BORROWED = {
  texts: [HTML_A], textR2Key: 'bills/100.html', matchType: null, aiProcessedAt: '2026-01-03 10:00:00',
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
    if (url === '/api/bills/42/text/9101' || url === '/api/bills/s200/text/9102') {
      // Typed as HTML on purpose: the frame must not trust the response's type.
      return new Response(PDF_BYTES, { status: 200, headers: { 'Content-Type': 'text/html' } })
    }
    if (url === '/api/bills/42/text/9001') return new Response(A_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

const summaryBox = async () => {
  await screen.findByText('AI Summary')
  return document.querySelector('.markdown-summary') as HTMLElement
}
/** The summary header names the bill a borrowed summary is from, by its badge (#712). */
const sourceBadge = async () => within((await screen.findByText('AI Summary')).parentElement as HTMLElement).getByText('S200')
const claimLink = (name: string) => screen.findByRole('link', { name })
const pdfFrame = async () => {
  await waitFor(() => expect(screen.queryByTitle('Bill text')).not.toBeNull(), { timeout: 3000 })
  return screen.getByTitle('Bill text') as HTMLIFrameElement
}
const caption = () => screen.getByRole('group', { name: /quote behind the claim/i })

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

describe('claim links on a PDF bill showing its own analysis', () => {
  it('links each unverified claim\'s own text, and leaves an ungrounded claim as plain text', async () => {
    setup()
    expect(await claimLink('Requires a drop box in each county.')).toHaveAttribute('href')
    expect(await claimLink('Boxes are emptied by two employees.')).toBeInTheDocument()
    expect((await summaryBox()).textContent).toContain('Something the text never says.')
    expect(screen.queryByRole('link', { name: 'Something the text never says.' })).toBeNull()
  })

  it('shows the quote and its page beside the link, and describes the link by it', async () => {
    setup()
    const link = await claimLink('Requires a drop box in each county.')
    expect(link).toHaveAccessibleDescription(`Page 7: “${Q1}”`)
    expect(link.closest('.claim-ref')!.querySelector('.claim-quote')!.textContent).toBe(`Page 7: “${Q1}”`)
    expect(await claimLink('Boxes are emptied by two employees.')).toHaveAccessibleDescription(`No page was cited, so the PDF opens at page 1: “${Q2}”`)
  })

  it('opens the pinned PDF at the cited page when a claim is clicked, and shows the quote', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await claimLink('Requires a drop box in each county.'))
    const f = await pdfFrame()
    expect(fetched).toContain('/api/bills/42/text/9101')
    expect(f.getAttribute('src')).toBe('blob:test/1#page=7')
    expect(caption()).toHaveTextContent('Page 7')
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${Q1}”`)
  })

  it('opens at page 1, with the quote still shown, for a claim with no cited page', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await claimLink('Boxes are emptied by two employees.'))
    const f = await pdfFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1#page=1')
    expect(caption()).toHaveTextContent('No page was cited')
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${Q2}”`)
  })

  it('forces the PDF blob\'s type, though the server called the file HTML', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await claimLink('Requires a drop box in each county.'))
    await pdfFrame()
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe('application/pdf')
    expect((screen.getByTitle('Bill text') as HTMLIFrameElement).hasAttribute('sandbox')).toBe(false)
  })

  it('opens the second claim at its own page in a new frame', async () => {
    const user = userEvent.setup()
    setup({ claimSources: { ...OWN_SOURCES, items: [OWN_SOURCES.items[0], { ...OWN_SOURCES.items[1], page: 3 }, OWN_SOURCES.items[2]] } })
    await user.click(await claimLink('Requires a drop box in each county.'))
    const first = await pdfFrame()
    await user.click(await claimLink('Boxes are emptied by two employees.'))
    await waitFor(() => expect((screen.getByTitle('Bill text') as HTMLIFrameElement).getAttribute('src')).toBe('blob:test/1#page=3'))
    expect(screen.getByTitle('Bill text')).not.toBe(first)
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${Q2}”`)
  })

  it('is reachable by Tab, activates with Enter, and moves focus to the quote', async () => {
    const user = userEvent.setup()
    setup()
    const link = await claimLink('Requires a drop box in each county.')
    link.focus()
    expect(link).toHaveFocus()
    await user.keyboard('{Enter}')
    await pdfFrame()
    await waitFor(() => expect(caption()).toHaveFocus())
  })

  it('says nothing about whose summary it is', async () => {
    setup()
    await claimLink('Requires a drop box in each county.')
    expect(screen.queryByText(/Summary of/)).toBeNull()
  })

  it('renders no links when the pinned PDF is not in the bill\'s text list', async () => {
    setup({ claimSources: { ...OWN_SOURCES, document: { ...PDF_A, docId: '9999' } } })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
    expect(document.querySelector('.claim-quote')).toBeNull()
  })

  it('renders no links when the server found the pinned PDF gone', async () => {
    setup({ claimSources: null })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
  })

  it('renders no links, and no quote, with the instance setting off, though claim sources are stored', async () => {
    setup({ claimLinksEnabled: false })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Boxes are emptied by two employees.' })).toBeNull()
    expect(document.querySelector('.claim-quote')).toBeNull()
  })

  it('renders an unverified claim on an HTML document as plain text', async () => {
    setup({ texts: [HTML_A], claimSources: { ...OWN_SOURCES, document: HTML_A } })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
  })
})

describe('claim links on a companion\'s page showing another member\'s PDF analysis', () => {
  it('opens the analyzed member\'s PDF at its page, never the page bill\'s own text, and shows its quote', async () => {
    const user = userEvent.setup()
    setup(BORROWED)
    await user.click(await claimLink('Requires a drop box in each county.'))
    const f = await pdfFrame()
    expect(fetched).toContain('/api/bills/s200/text/9102')
    expect(fetched.filter(u => u.startsWith('/api/bills/42/text/'))).toEqual([])
    expect(f.getAttribute('src')).toBe('blob:test/1#page=12')
    expect(caption()).toHaveTextContent('Page 12')
    expect(caption().querySelector('blockquote')!.textContent).toBe('“S200 words on drop boxes.”')
    expect(screen.getByRole('button', { name: /S200/ })).toBeInTheDocument()
    expect(blobs[0].type).toBe('application/pdf')
  })

  it('opens a zero page as page 1, with the quote shown', async () => {
    const user = userEvent.setup()
    setup(BORROWED)
    await user.click(await claimLink('Boxes are emptied by two employees.'))
    const f = await pdfFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1#page=1')
    expect(caption()).toHaveTextContent('isn’t usable')
    expect(caption().querySelector('blockquote')!.textContent).toBe('“S200 words on employees.”')
  })

  it('opens the companion\'s PDF even when the page bill has no texts of its own', async () => {
    const user = userEvent.setup()
    setup({ ...BORROWED, texts: [], textR2Key: null })
    await user.click(await claimLink('Requires a drop box in each county.'))
    const f = await pdfFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1#page=12')
  })

  it('labels the summary with the bill it is from, linking to that bill', async () => {
    setup(BORROWED)
    expect(await sourceBadge()).toBeInTheDocument()
    expect(screen.queryByText(/Summary of/)).toBeNull()
  })

  it('renders no links when the analyzed member\'s pinned PDF is gone, and still says whose summary it is', async () => {
    setup({ ...BORROWED, claimSources: null })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
    expect(await sourceBadge()).toBeInTheDocument()
    expect(screen.queryByText(/Summary of/)).toBeNull()
  })

  it('renders no links with the instance setting off, and still says whose summary it is', async () => {
    setup({ ...BORROWED, claimLinksEnabled: false })
    await summaryBox()
    expect(screen.queryByRole('link', { name: 'Requires a drop box in each county.' })).toBeNull()
    expect(await sourceBadge()).toBeInTheDocument()
  })

  it('follows the analysis back to the page bill\'s own PDF once the group shows A100\'s', async () => {
    const user = userEvent.setup()
    setup({ texts: [PDF_A] })
    await user.click(await claimLink('Requires a drop box in each county.'))
    const f = await pdfFrame()
    expect(fetched).toContain('/api/bills/42/text/9101')
    expect(f.getAttribute('src')).toBe('blob:test/1#page=7')
    expect(screen.queryByText(/Summary of/)).toBeNull()
  })
})

describe('a PDF bill\'s summary without claim sources', () => {
  it('renders exactly as today, from a server with or without the field', async () => {
    const { unmount } = setup({ claimSources: undefined, claimLinksEnabled: undefined })
    const today = (await summaryBox()).outerHTML
    unmount()
    setup({ claimSources: null })
    expect((await summaryBox()).outerHTML).toBe(today)
    const plain = render(<MarkdownSummary fontSize={fontSize.base} color={color.textSlate} lineHeight={1.5}>{SUMMARY}</MarkdownSummary>)
    expect(plain.container.querySelector('.markdown-summary')!.innerHTML).toBe((await summaryBox()).innerHTML)
    expect(document.querySelectorAll('a[data-claim], .claim-ref, .claim-quote')).toHaveLength(0)
  })

  it('shows no quote caption and no page fragment when the PDF is opened plainly', async () => {
    const user = userEvent.setup()
    setup({ claimSources: null })
    await summaryBox()
    await user.click(await screen.findByRole('button', { name: /bill text/i }))
    const f = await pdfFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1')
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
  })
})

// #696: the quote box closes, and focus goes back to the claim that opened it.
describe('the PDF quote box on a PDF bill\'s claims (#696)', () => {
  // The test setup's matchMedia reports no match for anything, so a device that can hover is stubbed in.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(hover: hover)', media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('previews a PDF claim\'s page line and quote on hover, outside the summary box', async () => {
    const user = userEvent.setup()
    setup()
    await user.hover(await claimLink('Requires a drop box in each county.'))
    const p = document.body.querySelector('[data-claim-preview]')
    expect(p!.textContent).toContain(`Page 7: “${Q1}”`)
    expect((await summaryBox()).contains(p)).toBe(false)
  })

  it('closes the box with its button and puts focus back on the claim that was clicked', async () => {
    const user = userEvent.setup()
    setup()
    const link = await claimLink('Requires a drop box in each county.')
    await user.click(link)
    await pdfFrame()
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.click(screen.getByRole('button', { name: /close quote/i }))
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
    expect(screen.getByRole('link', { name: 'Requires a drop box in each county.' })).toHaveFocus()
  })

  it('closes the box with Escape and returns focus to the second claim when that one opened it', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await claimLink('Boxes are emptied by two employees.'))
    await pdfFrame()
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
    expect(screen.getByRole('link', { name: 'Boxes are emptied by two employees.' })).toHaveFocus()
  })

  it('opens the box again when the same claim is clicked after closing it', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(await claimLink('Requires a drop box in each county.'))
    await pdfFrame()
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.click(screen.getByRole('button', { name: /close quote/i }))
    await user.click(screen.getByRole('link', { name: 'Requires a drop box in each county.' }))
    await waitFor(() => expect(caption()).toHaveFocus())
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${Q1}”`)
  })
})
