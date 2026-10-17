import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// Grouping and splitting bills by hand from the bill page's overflow menu
// (#382): an admin gets "Group with…" (a bill picker) and, on a grouped bill,
// "Split from group". A standard member gets neither.

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

// The bills the picker offers: this bill, its companion, a draft, and two others.
const BILL_OPTIONS = [
  { id: '42', billNumber: 'A190', title: 'Test Bill', state: 'RI', isDraft: false },
  { id: 'b1713', billNumber: 'S1713', title: 'Companion', state: 'RI', isDraft: false },
  { id: 'draft-1', billNumber: 'S1799', title: 'A draft', state: 'RI', isDraft: true },
  { id: 'c1714', billNumber: 'S1714', title: 'Another bill', state: 'RI', isDraft: false },
  { id: 'd1715', billNumber: 'S1715', title: 'Yet another', state: 'RI', isDraft: false },
]

// What splitting A190 would leave: S1713 and S1714, which only A190 linked.
const SPLIT_PREVIEW = { billNumber: 'A190', parts: [[{ billId: 'b1713', billNumber: 'S1713' }], [{ billId: 'c1714', billNumber: 'S1714' }]] }

const GROUPED = { groupBills: [{ billId: '42', billNumber: 'A190', state: 'RI', sessionSlug: '2026' }, { billId: 'b1713', billNumber: 'S1713', state: 'RI', sessionSlug: '2026' }] }

function renderBillDetail(overrides: Record<string, unknown> = {}) {
  const bill = { ...BILL, ...overrides }
  routerMock.loaderData = bill
  const apiFetch = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/42') return bill as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles' || path === '/users') return [] as never
    if (path === '/calendar/bill-options') return BILL_OPTIONS as never
    if (path === '/bills/42/split-preview') return SPLIT_PREVIEW as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  return apiFetch
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await screen.findAllByText('A190')
  await user.click(screen.getByRole('button', { name: 'More actions' }))
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
  authState.role = 'admin'
})

afterEach(() => { authState.role = 'admin' })

describe('grouping and splitting from the overflow menu', () => {
  it('offers an admin "Group with…" and, on a grouped bill, "Split from group"', async () => {
    const user = userEvent.setup()
    renderBillDetail(GROUPED)
    await openMenu(user)
    expect(screen.getByRole('menuitem', { name: /Group with…/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Split from group/ })).toBeInTheDocument()
  })

  it('offers no "Split from group" on a bill in no group', async () => {
    const user = userEvent.setup()
    renderBillDetail()
    await openMenu(user)
    expect(screen.getByRole('menuitem', { name: /Group with…/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Split from group/ })).toBeNull()
  })

  it('offers a standard member neither', async () => {
    const user = userEvent.setup()
    authState.role = 'member'
    renderBillDetail(GROUPED)
    await openMenu(user)
    expect(screen.queryByRole('menuitem', { name: /Group with…/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Split from group/ })).toBeNull()
  })

  it('groups the bill with the bill picked, from bills not already in its group', async () => {
    const user = userEvent.setup()
    const apiFetch = renderBillDetail(GROUPED)
    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: /Group with…/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Group A190 with another bill' })

    // Neither this bill, its companion, nor a draft can be picked.
    await user.type(within(dialog).getByPlaceholderText('Search bills…'), 'S17')
    const offered = within(dialog).getAllByRole('button').map(b => b.textContent ?? '').filter(t => t.startsWith('S17'))
    expect(offered).toEqual([expect.stringContaining('S1714'), expect.stringContaining('S1715')])

    await user.click(within(dialog).getByRole('button', { name: /S1714/ }))
    const reads = () => apiFetch.mock.calls.filter(([p]) => p === '/bills/42').length
    const readsBefore = reads()
    await user.click(within(dialog).getByRole('button', { name: 'Group bills' }))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/group', {
      method: 'POST',
      body: JSON.stringify({ withBillId: 'c1714' }),
    }))
    // The page reads the bill again, for its new group and grouping line.
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('splits the bill from its group once confirmed', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const apiFetch = renderBillDetail(GROUPED)
    await openMenu(user)
    const reads = () => apiFetch.mock.calls.filter(([p]) => p === '/bills/42').length
    const readsBefore = reads()
    await user.click(screen.getByRole('menuitem', { name: /Split from group/ }))
    // The confirmation names what the split leaves, from the server's preview.
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining(
      'S1713 and S1714 will no longer be grouped with each other either, since nothing else links them.')))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/split', { method: 'POST' }))
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore))
  })

  it('leaves the bill in its group when the split confirmation is declined', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const apiFetch = renderBillDetail(GROUPED)
    await openMenu(user)
    const reads = () => apiFetch.mock.calls.filter(([p]) => p === '/bills/42').length
    const readsBefore = reads()
    await user.click(screen.getByRole('menuitem', { name: /Split from group/ }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(apiFetch.mock.calls.some(([p]) => p === '/bills/42/split')).toBe(false)
    // Nothing was written, so the page isn't read again.
    expect(reads()).toBe(readsBefore)
  })

  describe('grouping again what was split', () => {
    const PAIR = (a: string, b: string) => [{ billId: a.toLowerCase(), billNumber: a }, { billId: b.toLowerCase(), billNumber: b }]
    const PREVIEW_PATH = '/bills/42/group-preview?withBillId=c1714'

    async function pickAndGroup(undoneSplits: unknown) {
      const user = userEvent.setup()
      const apiFetch = renderBillDetail(GROUPED)
      const answer = apiFetch.getMockImplementation()!
      apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path === PREVIEW_PATH) return { undoneSplits } as never
        return answer(path, init)
      })
      await openMenu(user)
      await user.click(screen.getByRole('menuitem', { name: /Group with…/ }))
      const dialog = await screen.findByRole('dialog', { name: 'Group A190 with another bill' })
      await user.type(within(dialog).getByPlaceholderText('Search bills…'), 'S1714')
      await user.click(within(dialog).getByRole('button', { name: /S1714/ }))
      await user.click(within(dialog).getByRole('button', { name: 'Group bills' }))
      return { apiFetch, dialog, user }
    }
    const posted = (apiFetch: ReturnType<typeof renderBillDetail>) => apiFetch.mock.calls.some(([p]) => p === '/bills/42/group')

    it('asks first, naming how many splits it undoes, and groups once confirmed', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const { apiFetch } = await pickAndGroup([PAIR('A190', 'S1714'), PAIR('S1713', 'S1714')])
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining('This undoes 2 splits: A190 and S1714, and S1713 and S1714.')))
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/bills/42/group', { method: 'POST', body: JSON.stringify({ withBillId: 'c1714' }) }))
    })

    it('writes nothing when the confirmation is declined, and leaves the dialog open to change the pick', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const { apiFetch, dialog } = await pickAndGroup([PAIR('A190', 'S1714')])
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      expect(posted(apiFetch)).toBe(false)
      expect(screen.getByRole('dialog', { name: 'Group A190 with another bill' })).toBe(dialog)
      // The button is usable again, so the admin can pick another bill or cancel.
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Group bills' })).not.toBeDisabled())
    })

    it('asks nothing when grouping undoes no split', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const { apiFetch } = await pickAndGroup([])
      await waitFor(() => expect(posted(apiFetch)).toBe(true))
      expect(confirm).not.toHaveBeenCalled()
    })

    it('groups without asking when the server sends no list of splits, as an older one would', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const { apiFetch } = await pickAndGroup(undefined)
      await waitFor(() => expect(posted(apiFetch)).toBe(true))
      expect(confirm).not.toHaveBeenCalled()
    })

    it('shows why the server refused the check, and groups nothing', async () => {
      const user = userEvent.setup()
      const apiFetch = renderBillDetail(GROUPED)
      const answer = apiFetch.getMockImplementation()!
      apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        if (path === PREVIEW_PATH) throw new api.ApiError(409, 'S1714 and S1713 were split apart.')
        return answer(path, init)
      })
      await openMenu(user)
      await user.click(screen.getByRole('menuitem', { name: /Group with…/ }))
      const dialog = await screen.findByRole('dialog', { name: 'Group A190 with another bill' })
      await user.type(within(dialog).getByPlaceholderText('Search bills…'), 'S1714')
      await user.click(within(dialog).getByRole('button', { name: /S1714/ }))
      await user.click(within(dialog).getByRole('button', { name: 'Group bills' }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('S1714 and S1713 were split apart.')
      expect(posted(apiFetch)).toBe(false)
    })
  })

  it("shows why the server refused a grouping, such as two bills split apart", async () => {
    const user = userEvent.setup()
    const apiFetch = renderBillDetail(GROUPED)
    const answer = apiFetch.getMockImplementation()!
    const refusal = 'S1714 and S1713 were split apart, and grouping A190 with S1714 would group them again. To undo that split, group S1713 with S1714.'
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/bills/42/group') throw new api.ApiError(409, refusal)
      return answer(path, init)
    })
    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: /Group with…/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Group A190 with another bill' })
    await user.type(within(dialog).getByPlaceholderText('Search bills…'), 'S1714')
    await user.click(within(dialog).getByRole('button', { name: /S1714/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Group bills' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(refusal)
  })

  it('says so when the split fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const apiFetch = renderBillDetail(GROUPED)
    const answer = apiFetch.getMockImplementation()!
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/bills/42/split') throw new Error('500')
      return answer(path, init)
    })
    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: /Split from group/ }))
    expect(await screen.findByText("Couldn't split the bill from its group. Try again.")).toBeInTheDocument()
  })
})

describe('the header of a bill an admin grouped by hand', () => {
  it("shows the companion's badge, linking to its page, though the bill names no relationship to it", async () => {
    renderBillDetail({ ...GROUPED, relatedBillIds: [] })
    const header = await screen.findByTestId('bill-group-badges')
    expect(within(header).getByRole('link', { name: 'S1713' })).toHaveAttribute('href', '/RI/2026/S1713')
    expect(within(header).getByText('A190').closest('a')).toBeNull()
    expect(screen.queryByText('Identical to:')).toBeNull()
  })

  it("shows only the bill's own badge on a bill in no group", async () => {
    renderBillDetail()
    await screen.findByText('Test Bill')
    expect(screen.getAllByText('A190')).toHaveLength(1)
    expect(screen.getByText('A190').closest('a')).toBeNull()
    expect(screen.queryByRole('link', { name: 'S1713' })).toBeNull()
  })
})

describe('the line saying what a group made by hand shares', () => {
  it("renders the same as for a provider's group: naming the companion, linking to its page, though no relationship links them", async () => {
    renderBillDetail({ ...GROUPED, relatedBillIds: [] })
    const line = await screen.findByTestId('group-shares-line')
    expect(line).toHaveTextContent('Comments, votes, and association position are shared with S1713.')
    expect(within(line).getByRole('link', { name: 'S1713' })).toHaveAttribute('href', '/RI/2026/S1713')
    expect(within(line).queryByText('A190')).toBeNull()
  })

  it('shows no line on a bill in no group', async () => {
    renderBillDetail()
    await screen.findByText('Test Bill')
    expect(screen.queryByTestId('group-shares-line')).toBeNull()
  })

  it('shows no line once the group splits and the bill stands alone again', async () => {
    renderBillDetail({ groupBills: [{ billId: '42', billNumber: 'A190', state: 'RI', sessionSlug: '2026' }] })
    await screen.findByText('Test Bill')
    expect(screen.queryByText(/are shared with/)).toBeNull()
  })
})
