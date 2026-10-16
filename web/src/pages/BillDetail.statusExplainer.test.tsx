import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// ── Scaffolding copied from BillDetail.readOnly.test.tsx ──────────────────────

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


const EXPLAINER = 'Passed by the Council and sent to the Mayor, who has 10 working days to sign or veto it.'
const DC_LABELS = {
  state: 'DC',
  statuses: [{ label: 'Under Mayoral Review', stage: 'passed', rank: 401, explainer: EXPLAINER }],
  billTypes: [], eventTypes: [], calendarName: 'DC Council calendar', hasEvents: false,
}

const VA_LABELS = {
  ...DC_LABELS, state: 'VA', calendarName: null,
  statuses: [{ label: 'Introduced', stage: 'introduced', rank: 101, explainer: 'Introduced and sent to a committee.' }],
}

const DEADLINE_EXPLAINER = 'A date the law sets for the measure\'s next step.'
const TYPE_EXPLAINER = 'Emergency act: takes effect once signed and lasts no more than 90 days.'
const HEARING_EXPLAINER = 'A committee hearing, where the public can testify.'
// Another state again, since each state's labels are fetched once per page load.
const MD_LABELS = {
  ...DC_LABELS, state: 'MD', calendarName: null, statuses: [],
  billTypes: [{ value: 'Emergency Bill', label: 'Emergency Bill', explainer: TYPE_EXPLAINER }],
  eventTypes: [
    { typeId: 1, label: 'Hearing', kind: 'hearing', explainer: HEARING_EXPLAINER },
    { typeId: 10, label: 'Deadline', kind: 'deadline', explainer: DEADLINE_EXPLAINER },
  ],
}

// The hover bubble is the one position:fixed copy of the text; the other is the
// visually hidden description screen readers get.
const bubbleWith = (text: string) => screen.getAllByText(text).find(el => el.style.position === 'fixed')
const RECT = { top: 10, bottom: 30, left: 100, right: 200, width: 100, height: 20, x: 100, y: 10, toJSON: () => ({}) } as DOMRect

// A state whose labels list no bill types.
const NJ_LABELS = { ...DC_LABELS, state: 'NJ', calendarName: null, statuses: [] }

function renderBillDetail(overrides: Record<string, unknown>) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  const spy = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/bills/labels?state=DC') return DC_LABELS as never
    if (path === '/bills/labels?state=VA') return VA_LABELS as never
    if (path === '/bills/labels?state=MD') return MD_LABELS as never
    if (path === '/bills/labels?state=NJ') return NJ_LABELS as never
    if (path === '/config/custom-fields') return [] as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  return spy
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})

describe('the status chip on a bill page', () => {
  it('explains the status on hover, from the state\'s labels', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0400', status: 'Under Mayoral Review' })
    await waitFor(() => {
      fireEvent.pointerEnter(screen.getByText('Under Mayoral Review'), { pointerType: 'mouse' })
      expect(bubbleWith(EXPLAINER)).toBeDefined()
    })
  })

  it('opens the hover bubble below the chip, so it can\'t clip past the top of the page', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0403', status: 'Under Mayoral Review' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Under Mayoral Review' })).toHaveAccessibleDescription(EXPLAINER))
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT)
    fireEvent.pointerEnter(screen.getByText('Under Mayoral Review'), { pointerType: 'mouse' })
    const bubble = bubbleWith(EXPLAINER)!
    expect(bubble.style.top).toBe('36px')
    expect(bubble.style.transform).not.toContain('translateY')
  })

  it('is unaffected by the term toggle: no underline, no wrapper button, and a click does not pin the explainer', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0406', status: 'Under Mayoral Review' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Under Mayoral Review' })).toHaveAccessibleDescription(EXPLAINER))
    const chip = screen.getByRole('button', { name: 'Under Mayoral Review' })
    expect(chip.closest('[style*="dotted"]')).toBeNull()
    expect(chip.parentElement?.tagName.toLowerCase()).toBe('span')
    expect(chip.querySelector('button')).toBeNull()
    fireEvent.click(chip)
    expect(bubbleWith(EXPLAINER)).toBeUndefined()
    fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
    expect(bubbleWith(EXPLAINER)).toBeDefined()
    fireEvent.pointerLeave(chip, { pointerType: 'mouse' })
    expect(bubbleWith(EXPLAINER)).toBeUndefined()
  })

  it('has no info button; screen readers get the explainer through aria-describedby', async () => {
    renderBillDetail({ state: 'DC', billNumber: 'B26-0401', status: 'Under Mayoral Review' })
    // Re-queried each time: the chip is re-created once the labels arrive.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Under Mayoral Review' })).toHaveAccessibleDescription(EXPLAINER))
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull()
  })

  it('shows no explainer for a status the state\'s labels don\'t list', async () => {
    // Another state, since each state's labels are fetched once per page load.
    const spy = renderBillDetail({ state: 'VA', billNumber: 'HB 1', status: 'Something new' })
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/bills/labels?state=VA'))
    fireEvent.pointerEnter(screen.getByText('Something new'), { pointerType: 'mouse' })
    expect(screen.queryByText(EXPLAINER)).toBeNull()
    expect(screen.queryByText('Introduced and sent to a committee.')).toBeNull()
  })

  it('asks for no labels for a draft, which has no status', async () => {
    const spy = renderBillDetail({ state: 'DC', billNumber: 'D1', status: '', isDraft: true })
    await screen.findByText('Test Bill')
    expect(spy).not.toHaveBeenCalledWith(expect.stringMatching(/^\/bills\/labels/))
  })
})

describe('deadlines and explainers on a bill page', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10)
  const calendar = [
    { eventHash: 'd-past', typeId: 10, type: 'Deadline', kind: 'deadline', date: day(-3), time: null, location: null, description: 'Mayor\'s response due' },
    { eventHash: 'd-later', typeId: 10, type: 'Deadline', kind: 'deadline', date: day(40), time: null, location: null, description: 'Act expires' },
    { eventHash: 'd-next', typeId: 10, type: 'Deadline', kind: 'deadline', date: day(9), time: null, location: null, description: 'Congressional review ends' },
    { eventHash: 'h1', typeId: 1, type: 'Hearing', kind: 'hearing', date: day(2), time: null, location: 'Room 412', description: 'Public Hearing' },
  ]

  it('shows the next deadline under the title, explained, and lists deadlines with the hearings', async () => {
    renderBillDetail({ state: 'MD', billNumber: 'B26-0400', billType: 'Emergency Bill', status: 'Introduced', calendar })
    const chip = await screen.findByTestId('next-deadline')
    expect(chip).toHaveTextContent('Congressional review ends')
    await waitFor(() => expect(within(chip).getByRole('button', { name: 'Congressional review ends' })).toHaveAccessibleDescription(DEADLINE_EXPLAINER))
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull()
    fireEvent.pointerEnter(within(chip).getByRole('button', { name: 'Congressional review ends' }), { pointerType: 'mouse' })
    expect(bubbleWith(DEADLINE_EXPLAINER)).toBeDefined()
    expect(screen.getByText('Hearings and deadlines')).toBeInTheDocument()
  })

  it('explains the bill type and each calendar entry from the state\'s labels', async () => {
    renderBillDetail({ state: 'MD', billNumber: 'B26-0400', body: 'C', billType: 'Emergency Bill', status: 'Introduced', calendar })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Public Hearing' })).toHaveAccessibleDescription(HEARING_EXPLAINER))
    expect(screen.queryByRole('button', { name: /^About / })).toBeNull()
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Public Hearing' }), { pointerType: 'mouse' })
    expect(bubbleWith(HEARING_EXPLAINER)).toBeDefined()
    fireEvent.pointerLeave(screen.getByRole('button', { name: 'Public Hearing' }), { pointerType: 'mouse' })
    await waitFor(() => {
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Council Emergency Bill' }), { pointerType: 'mouse' })
      expect(bubbleWith(TYPE_EXPLAINER)).toBeDefined()
    })
  })

  it('opens and closes the bill type\'s explainer on click, with the pointer cursor', async () => {
    renderBillDetail({ state: 'MD', billNumber: 'B26-0404', body: 'C', billType: 'Emergency Bill', status: 'Introduced', calendar })
    await waitFor(() => expect(document.getElementById('bill-type-explainer')).toHaveTextContent(TYPE_EXPLAINER))
    const label = screen.getByRole('button', { name: 'Council Emergency Bill' })
    expect(label.style.cursor).toBe('pointer')
    fireEvent.click(label)
    expect(bubbleWith(TYPE_EXPLAINER)).toBeDefined()
    fireEvent.click(label)
    expect(bubbleWith(TYPE_EXPLAINER)).toBeUndefined()
  })

  it('opens the next deadline\'s and a calendar entry\'s explainers on click, and closes on Escape', async () => {
    renderBillDetail({ state: 'MD', billNumber: 'B26-0405', body: 'C', billType: 'Emergency Bill', status: 'Introduced', calendar })
    const chip = await screen.findByTestId('next-deadline')
    const deadline = await waitFor(() => within(chip).getByRole('button', { name: 'Congressional review ends' }))
    fireEvent.click(deadline)
    expect(bubbleWith(DEADLINE_EXPLAINER)).toBeDefined()
    fireEvent.keyDown(deadline, { key: 'Escape' })
    expect(bubbleWith(DEADLINE_EXPLAINER)).toBeUndefined()
    const hearing = screen.getByRole('button', { name: 'Public Hearing' })
    fireEvent.click(hearing)
    expect(bubbleWith(HEARING_EXPLAINER)).toBeDefined()
  })

  it('opens the bill type\'s hover bubble below, with no info button and a described label', async () => {
    renderBillDetail({ state: 'MD', billNumber: 'B26-0402', body: 'C', billType: 'Emergency Bill', status: 'Introduced', calendar })
    await waitFor(() => expect(document.getElementById('bill-type-explainer')).toHaveTextContent(TYPE_EXPLAINER))
    const label = screen.getByText('Council Emergency Bill')
    expect(screen.queryByRole('button', { name: 'About "Council Emergency Bill"' })).toBeNull()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT)
    fireEvent.pointerEnter(label, { pointerType: 'mouse' })
    expect(bubbleWith(TYPE_EXPLAINER)!.style.top).toBe('36px')
  })

  it('renders a bill type with no explainer as plain text: no hover bubble, no description', async () => {
    const spy = renderBillDetail({ state: 'NJ', billNumber: 'HB 2', body: 'C', billType: 'B', status: 'Introduced' })
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/bills/labels?state=NJ'))
    const label = await screen.findByText('Council bill')
    expect(label).not.toHaveAttribute('aria-describedby')
    expect(document.getElementById('bill-type-explainer')).toBeNull()
    fireEvent.pointerEnter(label, { pointerType: 'mouse' })
    expect(Array.from(document.body.querySelectorAll('span')).some(el => el.style.position === 'fixed')).toBe(false)
  })

  it('shows no deadline chip for a bill without upcoming deadlines', async () => {
    renderBillDetail({ state: 'MD', billNumber: 'B26-0401', status: 'Introduced', calendar: calendar.filter(e => e.eventHash === 'd-past' || e.eventHash === 'h1') })
    await screen.findByText('Test Bill')
    expect(screen.queryByTestId('next-deadline')).toBeNull()
  })
})
