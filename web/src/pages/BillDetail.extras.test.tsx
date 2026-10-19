import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, title: null, canVote: authState.canVote },
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



const EXTRAS = {
  providerName: 'DC Council LIMS',
  fields: [
    { key: 'lawNumber', label: 'D.C. Law number', explainer: 'The number the act took when it became law.', display: 'identifier', value: 'L26-0042' },
    { key: 'effectiveDate', label: 'Effective date', explainer: null, display: 'date', value: '2026-06-01' },
    { key: 'packet', label: 'Introduction packet', explainer: null, display: 'link', value: 'https://lims.dccouncil.gov/downloads/B26-0001.pdf' },
    { key: 'withdrawnBy', label: 'Withdrawn by', explainer: null, display: 'text', value: 'Councilmember Example' },
  ],
}

function renderBillDetail(overrides: Record<string, unknown>) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})

describe('the provider extras panel on a bill page', () => {
  it('shows each extra under the provider\'s name, by its display type', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0001', extras: EXTRAS })
    const toggle = await screen.findByRole('button', { name: /Additional information from DC Council LIMS/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    expect(screen.getByText('D.C. Law number')).toBeInTheDocument()
    expect(screen.getByText('L26-0042')).toBeInTheDocument()
    expect(screen.getByText('2026-06-01')).toBeInTheDocument()
    expect(screen.getByText('Councilmember Example')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /lims\.dccouncil\.gov/ })
    expect(link).toHaveAttribute('href', 'https://lims.dccouncil.gov/downloads/B26-0001.pdf')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('explains an extra on hover over its label, with no info button', async () => {
    const explainer = 'The number the act took when it became law.'
    renderBillDetail({ state: 'DC', billNumber: 'B26-0001', extras: EXTRAS })
    fireEvent.click(await screen.findByRole('button', { name: /Additional information from/ }))
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull()
    const label = screen.getByRole('button', { name: 'D.C. Law number' })
    expect(label).toHaveAccessibleDescription(explainer)
    fireEvent.pointerEnter(label, { pointerType: 'mouse' })
    await waitFor(() => expect(screen.getAllByText(explainer).some(el => el.style.position === 'fixed')).toBe(true))
  })

  it('opens an extra\'s explainer on a click of its label, and closes it on a second click', async () => {
    const explainer = 'The number the act took when it became law.'
    const shown = () => screen.getAllByText(explainer).some(el => el.style.position === 'fixed')
    renderBillDetail({ state: 'DC', billNumber: 'B26-0001', extras: EXTRAS })
    fireEvent.click(await screen.findByRole('button', { name: /Additional information from/ }))
    const label = screen.getByRole('button', { name: 'D.C. Law number' })
    expect(label.style.cursor).toBe('pointer')
    fireEvent.click(label)
    expect(shown()).toBe(true)
    fireEvent.click(label)
    expect(shown()).toBe(false)
  })

  it('never turns a link that isn\'t http(s) into an href', async () => {
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001',
      extras: { providerName: 'DC Council LIMS', fields: [{ key: 'packet', label: 'Packet', explainer: null, display: 'link', value: 'javascript:alert(1)' }] },
    })
    await screen.findByRole('button', { name: /Additional information from/ })
    expect(screen.getByText('javascript:alert(1)').closest('a')).toBeNull()
  })

  it('keeps the line breaks of a multi-paragraph text value', async () => {
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001',
      extras: { providerName: 'DC Council LIMS', fields: [{ key: 'note', label: 'Note', explainer: null, display: 'text', value: 'First paragraph.\nSecond paragraph.' }] },
    })
    await screen.findByRole('button', { name: /Additional information from/ })
    expect(screen.getByText(/First paragraph\./)).toHaveStyle({ whiteSpace: 'pre-line' })
  })

  it('isn\'t there when the bill has no extras', async () => {
    renderBillDetail({ extras: null })
    await screen.findByText('Test Bill')
    expect(screen.queryByText(/Additional information from/)).toBeNull()
  })
})

// ── Placements: where each extra shows on the page ───────────────────────────

const field = (key: string, label: string, value: string, over: Record<string, unknown> = {}) =>
  ({ key, label, explainer: null, display: 'text', value, ...over })
const extrasOf = (providerName: string, fields: unknown[]) => ({ providerName, fields })
const foldOut = () => screen.queryByRole('button', { name: /Additional information from/ })

describe('extras placed in the meta row, the detail list, and as flags', () => {
  const dc = extrasOf('DC Council LIMS', [
    field('lawNumber', 'D.C. Law number', 'L26-0129', { display: 'identifier', placement: 'meta' }),
    field('actNumber', 'Act number', 'A26-0309', { display: 'identifier', placement: 'meta' }),
    field('requestedBy', 'Introduced at the request of', 'Mayor', { placement: 'meta' }),
    field('lawEffective', 'Law effective', '2026-06-11', { display: 'date', placement: 'meta' }),
    field('commentCommittees', 'Committees asked for comments', 'Youth Affairs, Judiciary', { placement: 'detail' }),
  ])

  it('shows a DC bill\'s numbers, requester, and effective date as "Label: value" items in the meta row, with no fold-out', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0001', body: 'C', extras: dc })
    const act = await screen.findByTestId('extra-meta-actNumber')
    expect(act).toHaveTextContent('Act number: A26-0309')
    expect(screen.getByTestId('extra-meta-lawNumber')).toHaveTextContent('D.C. Law number: L26-0129')
    expect(screen.getByTestId('extra-meta-requestedBy')).toHaveTextContent('Introduced at the request of: Mayor')
    expect(screen.getByTestId('extra-meta-lawEffective')).toHaveTextContent('Law effective: 2026-06-11')
    // They share the meta row with the body label.
    expect(act.parentElement).toBe(screen.getByText('Council bill').parentElement)
    expect(foldOut()).toBeNull()
  })

  it('shows the meta items after the body label and the next deadline, before the related bills', async () => {
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001', body: 'C', extras: dc,
      calendar: [{ id: 1, kind: 'deadline', date: '2999-01-01', type: 'Deadline', typeId: 10, description: 'Mayor\'s response due' }],
      relatedBillIds: [{ billId: 7, billNumber: 'B26-0002', kind: 'related', route: null }],
    })
    const row = (await screen.findByTestId('extra-meta-actNumber')).parentElement!
    const text = row.textContent!
    expect(text.indexOf('Council bill')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('Council bill')).toBeLessThan(text.indexOf('Mayor\'s response due'))
    expect(text.indexOf('Mayor\'s response due')).toBeLessThan(text.indexOf('Act number'))
    expect(text.indexOf('Law effective')).toBeLessThan(text.indexOf('B26-0002'))
  })

  it('shows a Maryland bill\'s chapter and between-chambers step in the meta row and its statutes as a full-width list under it, with no fold-out', async () => {
    const statutes = 'Example Article §§ 1-101, 1-102\nOther Article § 2-201'
    renderBillDetail({
      state: 'MD', billNumber: 'HB 1',
      extras: extrasOf('Example General Assembly', [
        field('chapter', 'Chapter', 'Chapter 5 of 2026', { display: 'identifier', placement: 'meta' }),
        field('statutes', 'Statutes affected', statutes, { placement: 'detail' }),
        field('chamberInteraction', 'Between the chambers', 'Conference Committee Appointed', { placement: 'meta' }),
      ]),
    })
    expect(await screen.findByTestId('extra-meta-chapter')).toHaveTextContent('Chapter: Chapter 5 of 2026')
    expect(screen.getByTestId('extra-meta-chamberInteraction')).toHaveTextContent('Between the chambers: Conference Committee Appointed')
    const detail = screen.getByTestId('extras-detail')
    expect(detail).toHaveTextContent('Statutes affected')
    expect(screen.getByText(/Example Article/)).toHaveStyle({ whiteSpace: 'pre-line' })
    expect(screen.getByText(/Example Article/).textContent).toBe(statutes)
    // The list is under the meta row, not inside it.
    const metaRow = screen.getByTestId('extra-meta-chapter').parentElement!
    expect(metaRow.contains(detail)).toBe(false)
    expect(metaRow.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(foldOut()).toBeNull()
  })

  it('shows the emergency and constitutional amendment flags as plain meta text, in the meta row beside the "House bill" label', async () => {
    renderBillDetail({
      state: 'MD', billNumber: 'HB 1',
      extras: extrasOf('Example General Assembly', [
        field('emergency', 'Emergency bill', 'Yes', { placement: 'flag' }),
        field('constitutionalAmendment', 'Constitutional amendment', 'Yes', { placement: 'flag' }),
      ]),
    })
    const emergency = await screen.findByTestId('extra-flag-emergency')
    const amendment = screen.getByTestId('extra-flag-constitutionalAmendment')
    expect(emergency).toHaveTextContent(/^Emergency bill$/)
    expect(amendment).toHaveTextContent(/^Constitutional amendment$/)
    // Same row as the body label, right after it, in the order central sent them.
    const label = screen.getByText('House bill')
    const row = emergency.parentElement!.parentElement!
    expect(row.contains(label)).toBe(true)
    expect(row.contains(amendment)).toBe(true)
    const order = [label, emergency, amendment]
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    // The label's noun is untouched.
    expect(screen.queryByText(/amendment bill|Emergency bill bill/i)).toBeNull()
    expect(foldOut()).toBeNull()
  })

  it('gives a flag no chip color: no amber or other background, and the label color a meta label has', async () => {
    renderBillDetail({
      state: 'MD', billNumber: 'HB 1',
      extras: extrasOf('Example General Assembly', [
        field('chapter', 'Chapter', 'Chapter 5', { placement: 'meta' }),
        field('emergency', 'Emergency bill', 'Yes', { placement: 'flag' }),
      ]),
    })
    const flag = await screen.findByTestId('extra-flag-emergency')
    const metaLabel = screen.getByTestId('extra-meta-chapter').firstElementChild as HTMLElement
    expect(flag.style.background).toBe('')
    expect(flag.style.backgroundColor).toBe('')
    expect(flag.style.borderRadius).toBe('')
    expect(flag.style.color).toBe(metaLabel.style.color)
  })

  it('shows a flag with no body label to sit beside', async () => {
    renderBillDetail({
      state: 'MD', billNumber: '1234',
      extras: extrasOf('Example General Assembly', [field('emergency', 'Emergency bill', 'Yes', { placement: 'flag' })]),
    })
    expect(await screen.findByTestId('extra-flag-emergency')).toBeInTheDocument()
  })

  it('leaves the next-deadline item amber when a flag is shown too', async () => {
    renderBillDetail({
      state: 'MD', billNumber: 'HB 1',
      calendar: [{ id: 1, kind: 'deadline', date: '2999-01-01', type: 'Deadline', typeId: 10, description: 'Governor must act' }],
      extras: extrasOf('Example General Assembly', [field('emergency', 'Emergency bill', 'Yes', { placement: 'flag' })]),
    })
    const deadline = await screen.findByTestId('next-deadline')
    expect(deadline.style.color).not.toBe('')
    expect(screen.getByTestId('extra-flag-emergency').style.color).not.toBe(deadline.style.color)
  })

  it('shows a flag whose value is not "Yes" as a "Label: value" meta item, never as a flag', async () => {
    renderBillDetail({
      state: 'MD', billNumber: 'HB 1',
      extras: extrasOf('Example General Assembly', [field('emergency', 'Emergency bill', 'Pending', { placement: 'flag' })]),
    })
    expect(await screen.findByTestId('extra-meta-emergency')).toHaveTextContent('Emergency bill: Pending')
    expect(screen.queryByTestId('extra-flag-emergency')).toBeNull()
    expect(foldOut()).toBeNull()
  })

  it('shows a Virginia bill with an earlier summary in the fold-out under its stage label, and its chapter in the meta row', async () => {
    renderBillDetail({
      state: 'VA', billNumber: 'HB 5',
      extras: extrasOf('Example General Assembly', [
        field('chapter', 'Chapter', 'Chapter 12 of the 2026 Acts of Assembly', { display: 'identifier', placement: 'meta' }),
        field('summaryIntroduced', 'Summary as introduced', 'A bill to study widgets.', { placement: 'panel' }),
      ]),
    })
    expect(await screen.findByTestId('extra-meta-chapter')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Additional information from Example General Assembly/ }))
    expect(screen.getByText('Summary as introduced')).toBeInTheDocument()
    expect(screen.getByText('A bill to study widgets.')).toBeInTheDocument()
    // The chapter is not repeated in the fold-out.
    expect(screen.getAllByText(/Chapter 12 of the 2026/)).toHaveLength(1)
  })

  const EVERY = extrasOf('Example Legislature', [
    field('m', 'Meta label', 'meta value', { placement: 'meta' }),
    field('d', 'Detail label', 'detail value', { placement: 'detail' }),
    field('f', 'Flag label', 'Yes', { placement: 'flag' }),
    field('p', 'Panel label', 'panel value', { placement: 'panel' }),
    field('n', 'Unplaced label', 'unplaced value'),
  ])

  it('renders an extra of every placement in its place, and the fold-out holds only the panel ones', async () => {
    renderBillDetail({ state: 'MD', billNumber: 'HB 1', extras: EVERY })
    expect(await screen.findByTestId('extra-meta-m')).toHaveTextContent('Meta label: meta value')
    expect(screen.getByTestId('extras-detail')).toHaveTextContent('Detail labeldetail value')
    expect(screen.getByTestId('extra-flag-f')).toHaveTextContent('Flag label')
    const toggle = screen.getByRole('button', { name: /Additional information from Example Legislature/ })
    expect(toggle).toHaveTextContent('2')
    fireEvent.click(toggle)
    expect(screen.getByText('Panel label')).toBeInTheDocument()
    expect(screen.getByText('Unplaced label')).toBeInTheDocument()
    // Each field shows once.
    for (const text of ['Meta label', 'Detail label', 'Flag label', 'Panel label', 'Unplaced label']) {
      expect(screen.getAllByText(new RegExp(`^${text}:?$`)), text).toHaveLength(1)
    }
  })

  it('has no fold-out when every extra is placed elsewhere, and a #section-extras link still loads', async () => {
    routerMock.location.hash = '#section-extras'
    renderBillDetail({ state: 'DC', billNumber: 'B26-0001', body: 'C', extras: dc })
    expect(await screen.findByTestId('extra-meta-actNumber')).toBeInTheDocument()
    expect(foldOut()).toBeNull()
    expect(document.getElementById('section-extras')).toBeNull()
  })

  it('shows every field in the fold-out for a payload with no placement, as before', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0001', extras: EXTRAS })
    fireEvent.click(await screen.findByRole('button', { name: /Additional information from DC Council LIMS/ }))
    for (const label of ['D.C. Law number', 'Effective date', 'Introduction packet', 'Withdrawn by']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.queryByTestId('extra-meta-lawNumber')).toBeNull()
    expect(screen.queryByTestId('extras-detail')).toBeNull()
  })

  it('shows a placement it does not know in the fold-out', async () => {
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001',
      extras: extrasOf('DC Council LIMS', [field('x', 'Banner thing', 'banner value', { placement: 'banner' })]),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Additional information from DC Council LIMS/ }))
    expect(screen.getByText('banner value')).toBeInTheDocument()
  })

  it('explains a meta item\'s label on hover and on click, as the fold-out does', async () => {
    const explainer = 'The number the act took.'
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001',
      extras: extrasOf('DC Council LIMS', [field('actNumber', 'Act number', 'A26-0309', { display: 'identifier', explainer, placement: 'meta' })]),
    })
    const label = await screen.findByRole('button', { name: 'Act number' })
    expect(label).toHaveAccessibleDescription(explainer)
    fireEvent.pointerEnter(label, { pointerType: 'mouse' })
    await waitFor(() => expect(screen.getAllByText(explainer).some(el => el.style.position === 'fixed')).toBe(true))
    fireEvent.pointerLeave(label, { pointerType: 'mouse' })
    fireEvent.click(label)
    expect(screen.getAllByText(explainer).some(el => el.style.position === 'fixed')).toBe(true)
  })

  it('keeps a 256-character committee list inside the page width: it wraps, with no nowrap on the item, the row, or the list', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Committee on Example Matters ${i + 1}`).join(', ').slice(0, 256).trimEnd() + 'x'
    expect(long).toHaveLength(256)
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001',
      extras: extrasOf('DC Council LIMS', [
        field('requestedBy', 'Introduced at the request of', long, { placement: 'meta' }),
        field('commentCommittees', 'Committees asked for comments', long, { placement: 'detail' }),
      ]),
    })
    const item = await screen.findByTestId('extra-meta-requestedBy')
    expect(item.style.whiteSpace).not.toBe('nowrap')
    expect(item).toHaveStyle({ maxWidth: '100%', minWidth: '0', overflowWrap: 'anywhere' })
    // The row wraps its items, so one long item gets a line of its own.
    expect(item.parentElement).toHaveStyle({ flexWrap: 'wrap' })
    const detail = screen.getByTestId('extras-detail')
    expect(detail).toHaveStyle({ width: '100%' })
    expect(within(detail).getByText(long)).toHaveStyle({ overflowWrap: 'anywhere' })
  })

  it('shows a date through safeDate, and nothing at all for a placeholder date', async () => {
    renderBillDetail({
      state: 'DC', billNumber: 'B26-0001',
      extras: extrasOf('DC Council LIMS', [
        field('lawEffective', 'Law effective', '2026-06-11', { display: 'date', placement: 'meta' }),
        field('withdrawnOn', 'Withdrawn on', '0000-00-00', { display: 'date', placement: 'meta' }),
        field('packetDate', 'Packet date', '0000-00-00', { display: 'date' }),
      ]),
    })
    expect(await screen.findByTestId('extra-meta-lawEffective')).toHaveTextContent('Law effective: 2026-06-11')
    expect(screen.queryByText(/Withdrawn on/)).toBeNull()
    expect(screen.queryByText(/0000-00-00/)).toBeNull()
    expect(foldOut()).toBeNull()
  })
})
