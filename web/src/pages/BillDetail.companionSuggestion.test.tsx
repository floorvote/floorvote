import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'
import { CARD } from '../lib/cardStyle'

// Companion suggestions from matching titles (#521): an admin's bill page shows
// "Possibly the same as SB200." above the comments, where a grouped bill names
// its companions, when the server suggests a bill. "Group them" groups the two as "Group with…" does,
// with the same confirmation when it would undo splits, and "Dismiss" keeps the
// pair from being suggested again.

// ── Scaffolding copied from BillDetail.companionGroup.test.tsx ────────────────

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
  RichTextEditor: ({ submitLabel = 'Post', onSubmit, disabled }: { submitLabel?: string; onSubmit?: (html: string) => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onSubmit?.('<p>hi</p>')}>{submitLabel}</button>
  ),
}))

vi.mock('../components/PositionBadge', () => ({
  PositionBadge: ({ position }: { position: string }) => <span>{position}</span>,
}))

vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoLocked: false }),
}))

const authState = vi.hoisted(() => ({ role: 'admin' as 'member' | 'admin' | 'owner' }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authState.role, subtitle: null, canVote: true },
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
  billNumber: 'A190',
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
  tenantSummary: null,
  tags: [],
  relevanceScore: null,
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
  myNote: null,
  priorityMeta: null,
  position: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0, total: 0 },
  memberVotes: [],
  comments: [],
  commentsTotal: 0,
  groupBills: [{ billId: '42', billNumber: 'A190', state: 'RI', sessionSlug: '2026' }],
}

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}

const SUGGESTION = { billId: 's200', billNumber: 'SB200', state: 'PA', sessionSlug: '2025-2026' }
const GROUPED = { companionSuggestion: null, groupBills: [{ billId: '42', billNumber: 'A190', state: 'PA', sessionSlug: '2026' }, { billId: 's200', billNumber: 'SB200', state: 'PA', sessionSlug: '2025-2026' }] }

function renderBillDetail(overrides: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
  let bill: Record<string, unknown> = { ...BILL, state: 'PA', companionSuggestion: SUGGESTION, ...overrides }
  routerMock.loaderData = bill
  const apiFetch = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path in answers) {
      const answer = answers[path]
      if (answer instanceof Error) throw answer
      return answer as never
    }
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG, states: ['PA'] } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles' || path === '/users') return [] as never
    if (path === '/bills/42/group-preview?withBillId=s200') return { undoneSplits: [] } as never
    if (path === '/bills/42/group' && init?.method === 'POST') { bill = { ...bill, ...GROUPED }; return GROUPED as never }
    if (path === '/bills/42/companion-suggestion/dismiss' && init?.method === 'POST') { bill = { ...bill, companionSuggestion: null }; return { ok: true } as never }
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  return apiFetch
}

const line = () => screen.queryByTestId('companion-suggestion-line')
const reads = (apiFetch: ReturnType<typeof renderBillDetail>) => apiFetch.mock.calls.filter(([p]) => p === '/bills/42').length

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
  authState.role = 'admin'
})

afterEach(() => { authState.role = 'admin' })

describe('the companion suggestion line', () => {
  it('names the suggested bill as a badge linking to its page', async () => {
    renderBillDetail()
    const shown = await screen.findByTestId('companion-suggestion-line')
    expect(shown).toHaveTextContent('Possibly the same as SB200.')
    expect(within(shown).getByRole('link', { name: /SB200/ })).toHaveAttribute('href', '/PA/2025-2026/SB200')
    expect(within(shown).getByRole('button', { name: 'Group them' })).toBeInTheDocument()
    expect(within(shown).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('is absent when the server suggests nothing', async () => {
    renderBillDetail()
    expect(await screen.findByTestId('companion-suggestion-line')).toBeInTheDocument()
    cleanup()
    renderBillDetail({ companionSuggestion: null })
    await screen.findAllByText('A190')
    expect(line()).toBeNull()
  })

  it('is absent for a standard member, even if a suggestion arrived', async () => {
    renderBillDetail()
    expect(await screen.findByTestId('companion-suggestion-line')).toBeInTheDocument()
    cleanup()
    authState.role = 'member'
    renderBillDetail()
    await screen.findAllByText('A190')
    expect(line()).toBeNull()
  })

  it('sits below the line naming the bill\'s group if both arrive', async () => {
    renderBillDetail({ groupBills: [{ billId: '42', billNumber: 'A190', state: 'PA', sessionSlug: '2026' }, { billId: 'h300', billNumber: 'HB300', state: 'PA', sessionSlug: '2026' }] })
    expect(await screen.findByTestId('companion-suggestion-line')).toBeInTheDocument()
    expect(screen.getByTestId('group-shares-line')).toBeInTheDocument()
  })

  // The shares line lines up with the comments heading (the card's 1px border and 16px of padding), and the
  // suggestion line under it keeps the same inset, alone or beside it.
  it('starts at the same inset as the comments heading, alone and under the shares line', async () => {
    const inset = (el: Element) => parseFloat(getComputedStyle(el).marginLeft)
    renderBillDetail()
    const alone = await screen.findByTestId('companion-suggestion-line')
    const card = document.getElementById('section-comments') as HTMLElement
    const headingOffset = parseFloat(CARD.border) + parseFloat(getComputedStyle(card).paddingLeft)
    expect(inset(alone)).toBe(headingOffset)
    cleanup()
    renderBillDetail({ groupBills: [{ billId: '42', billNumber: 'A190', state: 'PA', sessionSlug: '2026' }, { billId: 'h300', billNumber: 'HB300', state: 'PA', sessionSlug: '2026' }] })
    const shares = await screen.findByTestId('group-shares-line')
    expect(inset(shares)).toBe(headingOffset)
    expect(inset(screen.getByTestId('companion-suggestion-line'))).toBe(headingOffset)
  })
})

describe('grouping from the suggestion', () => {
  it('groups the two bills as "Group with…" does, and reads the bill again', async () => {
    const user = userEvent.setup()
    const apiFetch = renderBillDetail()
    const shown = await screen.findByTestId('companion-suggestion-line')
    const before = reads(apiFetch)
    await user.click(within(shown).getByRole('button', { name: 'Group them' }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/group-preview?withBillId=s200'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/group', { method: 'POST', body: JSON.stringify({ withBillId: 's200' }) }))
    await waitFor(() => expect(reads(apiFetch)).toBeGreaterThan(before))
    await waitFor(() => expect(line()).toBeNull())
    expect(screen.getByTestId('group-shares-line')).toHaveTextContent('SB200')
  })

  it('asks first when grouping would undo splits, and writes nothing if declined', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const PAIR = [{ billId: 'h300', billNumber: 'HB300' }, { billId: 's200', billNumber: 'SB200' }]
    const apiFetch = renderBillDetail({}, { '/bills/42/group-preview?withBillId=s200': { undoneSplits: [PAIR] } })
    const shown = await screen.findByTestId('companion-suggestion-line')
    await user.click(within(shown).getByRole('button', { name: 'Group them' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining('HB300 and SB200')))
    expect(apiFetch.mock.calls.some(([p]) => p === '/bills/42/group')).toBe(false)
    expect(line()).not.toBeNull()
  })

  it('groups once the undone splits are confirmed', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const PAIR = [{ billId: 'h300', billNumber: 'HB300' }, { billId: 's200', billNumber: 'SB200' }]
    const apiFetch = renderBillDetail({}, { '/bills/42/group-preview?withBillId=s200': { undoneSplits: [PAIR] } })
    const shown = await screen.findByTestId('companion-suggestion-line')
    await user.click(within(shown).getByRole('button', { name: 'Group them' }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/group', { method: 'POST', body: JSON.stringify({ withBillId: 's200' }) }))
  })

  it('says why when the server refuses the grouping', async () => {
    const user = userEvent.setup()
    const refusal = new api.ApiError(409, 'HB300 and SB200 were split apart, and grouping A190 with SB200 would group them again.')
    renderBillDetail({}, { '/bills/42/group-preview?withBillId=s200': refusal })
    const shown = await screen.findByTestId('companion-suggestion-line')
    await user.click(within(shown).getByRole('button', { name: 'Group them' }))
    expect(await screen.findByText(/were split apart/)).toBeInTheDocument()
  })
})

describe('dismissing the suggestion', () => {
  it('dismisses the pair and hides the line', async () => {
    const user = userEvent.setup()
    const apiFetch = renderBillDetail()
    const shown = await screen.findByTestId('companion-suggestion-line')
    await user.click(within(shown).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/companion-suggestion/dismiss', { method: 'POST', body: JSON.stringify({ withBillId: 's200' }) }))
    await waitFor(() => expect(line()).toBeNull())
    expect(apiFetch.mock.calls.some(([p]) => p === '/bills/42/group')).toBe(false)
  })

  it('keeps the line and says so when the dismissal fails', async () => {
    const user = userEvent.setup()
    renderBillDetail({}, { '/bills/42/companion-suggestion/dismiss': new Error('down') })
    const shown = await screen.findByTestId('companion-suggestion-line')
    await user.click(within(shown).getByRole('button', { name: 'Dismiss' }))
    expect(await screen.findByText("Couldn't dismiss the suggestion. Try again.")).toBeInTheDocument()
    expect(line()).not.toBeNull()
  })
})
