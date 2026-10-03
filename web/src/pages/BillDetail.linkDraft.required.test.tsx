import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'
import { itGatesQuietly, expectMessageHidden, expectMessageShown, expectQuietlyBlocked } from '../test/quietGate'

// The quiet required-field gate on the "Link draft" control: a filed bill must
// be chosen before the draft can be linked. The picker's search input keeps
// aria-required; this single-input control shows no asterisk or legend. The
// link button looks disabled until a bill is chosen and says "Fill in the
// required items first." only when someone tries it.

const navigateMock = vi.hoisted(() => vi.fn())
const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' },
  loaderData: null as unknown,
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useParams: () => routerMock.params,
    useNavigate: () => navigateMock,
    useNavigation: () => ({ state: 'idle' }),
    useLocation: () => routerMock.location,
    useLoaderData: () => routerMock.loaderData,
  }
})

vi.mock('../lib/scrollUtils', () => ({ getScrollContainer: () => ({ scrollTo: vi.fn() }) }))
vi.mock('../components/RichTextEditor', () => ({ RichTextEditor: () => null }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'admin', subtitle: null, canVote: true },
    loading: false,
  }),
}))
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked, settled: true, demoResetAt: 'epoch-1' }),
}))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({ unreadCount: 0, mentions: [], refresh: vi.fn(async () => {}) }),
}))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

const DRAFT = {
  id: '42',
  externalId: null,
  billNumber: 'D1',
  title: 'Pre-filed draft',
  state: 'RI',
  status: '',
  statusDate: null,
  session: '',
  sessionId: null,
  sessionSlug: '2026',
  yearStart: 2026,
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
  companionBillIds: [],
  texts: [],
  calendar: [],
  supplements: [],
  amendments: [],
  customFieldValues: {},
  matchType: 'manual' as const,
  isDraft: true,
  draftText: null,
  createdAt: '2026-01-01 00:00:00',
  updatedAt: '2026-01-01 00:00:00',
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
}

const CONFIG = {
  associationName: 'Test Assoc',
  positionVocabulary: ['support', 'oppose', 'neutral'],
  states: ['RI'],
  instanceDomains: {},
  orgNoun: 'association',
}

const FILED = [
  { id: 'f1', billNumber: 'H 100', title: 'Filed elections bill', state: 'RI', isDraft: false },
  { id: 'f2', billNumber: 'S 200', title: 'Filed records bill', state: 'RI', isDraft: false },
]

function mockApi({ holdLink = false }: { holdLink?: boolean } = {}) {
  let release: () => void = () => {}
  const links: unknown[] = []
  routerMock.loaderData = { ...DRAFT }
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/42' || path.startsWith('/bills/resolve/')) return { ...DRAFT } as never
    if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D2', year: 2026, tenantState: 'RI' } as never
    if (path === '/calendar/bill-options') return FILED as never
    if (path === '/bills/42/link' && init?.method === 'POST') {
      links.push(JSON.parse(String(init.body)))
      if (holdLink) await new Promise<void>(resolve => { release = resolve })
      return { ok: true, filedBillId: 'f1' } as never
    }
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
  return { links, release: () => release() }
}

async function setup() {
  const user = userEvent.setup()
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  const group = await screen.findByRole('group', { name: /link to filed bill/i })
  return { user, group }
}

const linkButton = () => screen.getByRole('button', { name: /^(link & merge into filed bill|linking…)$/i })
const search = () => screen.getByRole('textbox', { name: /filed bill/i })

async function pick(user: ReturnType<typeof userEvent.setup>, query: string, number: string) {
  await user.type(search(), query)
  await user.click(await screen.findByRole('button', { name: new RegExp(number) }))
}

let confirmSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.restoreAllMocks()
  navigateMock.mockClear()
  demoState.demoLocked = false
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { vi.restoreAllMocks(); demoState.demoLocked = false })

describe('BillDetail link draft: quiet gate while no filed bill is chosen', () => {
  itGatesQuietly(async () => {
    const { links } = mockApi()
    const { user, group } = await setup()
    // Trying the button must not even reach the confirm dialog.
    return { user, button: linkButton, submitted: () => links.length + confirmSpy.mock.calls.length, scope: () => group }
  })
})

describe('BillDetail link draft: markers', () => {
  it('shows no "* Required" legend and no asterisk', async () => {
    mockApi()
    const { group } = await setup()
    expect(screen.queryByText('Required')).not.toBeInTheDocument()
    expect(group.textContent).not.toContain('*')
  })

  it('keeps aria-required on the filed-bill search, with a plain label', async () => {
    mockApi()
    await setup()
    expect(search()).toHaveAttribute('aria-required', 'true')
    expect(search()).toHaveAccessibleName('Filed bill')
    const label = document.querySelector(`label[for="${search().id}"]`) as HTMLLabelElement
    expect(label.textContent).toBe('Filed bill')
  })
})

describe('BillDetail link draft: choosing and removing a bill', () => {
  it('stays blocked, quietly, while a search is typed but nothing is chosen', async () => {
    mockApi()
    const { user } = await setup()
    await user.type(search(), 'H 1')
    expectQuietlyBlocked(linkButton())
    expectMessageHidden(linkButton())
  })

  it('lifts the gate once a filed bill is chosen, with no message on hover', async () => {
    mockApi()
    const { user } = await setup()
    await pick(user, 'H 1', 'H 100')
    expect(linkButton()).toBeEnabled()
    expect(linkButton()).not.toHaveAttribute('aria-disabled')
    await user.hover(linkButton())
    expectMessageHidden(linkButton())
  })

  it('hides a shown message once a filed bill is chosen', async () => {
    mockApi()
    const { user } = await setup()
    await user.hover(linkButton())
    expectMessageShown(linkButton())
    await user.unhover(linkButton())
    await pick(user, 'H 1', 'H 100')
    await user.hover(linkButton())
    expectMessageHidden(linkButton())
  })

  it('blocks quietly again when the chosen bill is removed', async () => {
    mockApi()
    const { user } = await setup()
    await pick(user, 'H 1', 'H 100')
    await user.click(screen.getByRole('button', { name: 'Remove H 100' }))
    expectQuietlyBlocked(linkButton())
    expectMessageHidden(linkButton())
  })

  it('links to the chosen bill', async () => {
    const { links } = mockApi()
    const { user } = await setup()
    await pick(user, 'S 2', 'S 200')
    await user.click(linkButton())
    await waitFor(() => expect(links).toEqual([{ filedBillId: 'f2' }]))
    expect(confirmSpy).toHaveBeenCalled()
  })
})

describe('BillDetail link draft: other disabled reasons show no message', () => {
  it('demo lock with a bill chosen: natively disabled, quiet', async () => {
    demoState.demoLocked = true
    mockApi()
    const { user } = await setup()
    await pick(user, 'H 1', 'H 100')
    expect(linkButton()).toBeDisabled()
    expect(linkButton()).not.toHaveAttribute('aria-disabled')
    await user.hover(linkButton())
    expectMessageHidden(linkButton())
  })

  it('demo lock with no bill chosen: natively disabled, quiet', async () => {
    demoState.demoLocked = true
    mockApi()
    const { user } = await setup()
    expect(linkButton()).toBeDisabled()
    await user.hover(linkButton())
    expectMessageHidden(linkButton())
  })

  it('a link request in flight: natively disabled, quiet', async () => {
    const { links, release } = mockApi({ holdLink: true })
    const { user } = await setup()
    await pick(user, 'H 1', 'H 100')
    await user.click(linkButton())
    await waitFor(() => expect(links).toHaveLength(1))
    const busy = screen.getByRole('button', { name: /linking/i })
    expect(busy).toBeDisabled()
    expect(busy).not.toHaveAttribute('aria-disabled')
    expectMessageHidden(busy)
    await act(async () => { release() })
  })
})
