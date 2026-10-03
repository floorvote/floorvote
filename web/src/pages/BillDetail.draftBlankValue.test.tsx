import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'
import { REQUIRED_MESSAGE } from '../components/RequiredField'
import { itGatesQuietly, expectMessageShown, expectMessageHidden, expectQuietlyBlocked, gateMessage } from '../test/quietGate'

// The draft bill-number and State inline editors refuse a blank value with the
// shared quiet gate: while the value is blank or whitespace, Save looks
// disabled (aria-disabled) and reveals "Fill in the required items first." on
// hover, focus, click/tap, or Enter in the field, sending nothing and keeping
// the editor open. Harness mirrors BillDetail.draftState.test.tsx.
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
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }),
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

type Opts = {
  /** What GET /bills/draft-defaults reports: null on a multi-state tenant
   *  (the State editor is offered), a postal code on a single-state one. */
  tenantState?: string | null
  /** GET /bills/facets `state`. Omitted mocks a failure, which makes the
   *  State editor fall back to free text. */
  facetStates?: Record<string, number>
}

function mockApi(opts: Opts = {}) {
  routerMock.loaderData = { ...DRAFT }
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/42' || path.startsWith('/bills/resolve/')) return { ...DRAFT } as never
    if (path.startsWith('/bills/draft-defaults')) {
      return { billNumber: 'D2', year: 2026, tenantState: 'tenantState' in opts ? opts.tenantState : null } as never
    }
    if (path === '/bills/facets') {
      if (opts.facetStates) return { state: opts.facetStates } as never
      throw new api.ApiError(500, 'facets unavailable')
    }
    if (path === '/bills/42/draft' && init?.method === 'PATCH') {
      return { ...DRAFT, ...JSON.parse(String(init.body)) } as never
    }
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

function patchCalls() {
  return vi.mocked(api.apiFetch).mock.calls.filter(([path, init]) => path === '/bills/42/draft' && init?.method === 'PATCH')
}

function renderPage() {
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

beforeEach(() => {
  vi.restoreAllMocks()
  navigateMock.mockClear()
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
})
afterEach(() => vi.restoreAllMocks())

const saveButton = () => screen.getByRole('button', { name: 'Save' })
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' })

describe('BillDetail draft bill-number editor: blank value', () => {
  async function openEditor() {
    const user = userEvent.setup()
    mockApi({ tenantState: 'RI' })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit bill number' }))
    return { user, input: screen.getByRole('textbox', { name: /bill number/i }) as HTMLInputElement }
  }

  describe('Save gated while the bill number is empty', () => {
    itGatesQuietly(async () => {
      const { user, input } = await openEditor()
      await user.clear(input)
      return { user, button: saveButton, submitted: () => patchCalls().length }
    })
  })

  describe('Save gated while the bill number is whitespace', () => {
    itGatesQuietly(async () => {
      const { user, input } = await openEditor()
      await user.clear(input)
      await user.type(input, '   ')
      return { user, button: saveButton, submitted: () => patchCalls().length }
    })
  })

  it('opens with the current number, a required input, Save enabled, and no message', async () => {
    const { input } = await openEditor()
    expect(input).toHaveValue('D1')
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(saveButton()).not.toHaveAttribute('aria-disabled')
    expect(saveButton().style.cursor).toBe('pointer')
    expectMessageHidden(saveButton())
    expect(input).not.toHaveAttribute('aria-describedby')
  })

  it('greys Save as soon as the number is cleared, without showing the message', async () => {
    const { user, input } = await openEditor()
    const enabledBackground = saveButton().style.background
    await user.clear(input)
    expectQuietlyBlocked(saveButton())
    expect(saveButton().style.background).not.toBe(enabledBackground)
    expectMessageHidden(saveButton())
  })

  it('no longer uses the old "Bill number is required" text or an alert', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.click(saveButton())
    await user.type(input, '{Enter}')
    expect(screen.queryByText(/is required/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Enter on a blank number does not save, and reveals the message tied to the field', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expect(patchCalls()).toHaveLength(0)
    expectMessageShown(saveButton())
    expect(input).toHaveAccessibleDescription(REQUIRED_MESSAGE)
  })

  it('Enter on a whitespace-only number does not save, and reveals the message', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '   {Enter}')
    expect(patchCalls()).toHaveLength(0)
    expectMessageShown(saveButton())
  })

  it('keeps the editor open after a refused save', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.click(saveButton())
    await user.type(input, '{Enter}')
    expect(screen.getByRole('textbox', { name: /bill number/i })).toBe(input)
    expect(screen.queryByRole('button', { name: 'Edit bill number' })).not.toBeInTheDocument()
  })

  it('hides the message once a value is entered, and then saves it', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expectMessageShown(saveButton())

    await user.type(input, 'D9')
    expectMessageHidden(saveButton())
    expect(input).not.toHaveAttribute('aria-describedby')

    await user.click(saveButton())
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ billNumber: 'D9' }) }),
    ))
    expect(await screen.findByRole('button', { name: 'Edit bill number' })).toHaveTextContent('Bill number: D9')
  })

  it('saves a trimmed value with Enter', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, ' D7 {Enter}')
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ billNumber: 'D7' }) }),
    ))
  })

  it('Cancel closes the editor; reopening shows no message', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '{Enter}')
    await user.click(saveButton())
    expectMessageShown(saveButton())

    await user.click(cancelButton())
    expect(gateMessage()).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit bill number' })).toHaveTextContent('Bill number: D1')

    await user.click(screen.getByRole('button', { name: 'Edit bill number' }))
    const again = screen.getByRole('textbox', { name: /bill number/i })
    expect(again).toHaveValue('D1')
    await user.clear(again)
    expectMessageHidden(saveButton())
  })

  it('Escape closes the editor; reopening shows no message', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expectMessageShown(saveButton())

    await user.type(input, '{Escape}')
    expect(gateMessage()).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Edit bill number' }))
    await user.clear(screen.getByRole('textbox', { name: /bill number/i }))
    expectMessageHidden(saveButton())
  })

  it('reopening after a save made while Save was hovered starts quiet', async () => {
    const { user, input } = await openEditor()
    await user.hover(saveButton())
    await user.type(input, '9{Enter}', { skipClick: true })
    const edit = await screen.findByRole('button', { name: 'Edit bill number' })

    fireEvent.click(edit)
    fireEvent.change(screen.getByRole('textbox', { name: /bill number/i }), { target: { value: '' } })
    expectMessageHidden(saveButton())
  })
})

describe('BillDetail draft State editor (free text): blank value', () => {
  async function openEditor() {
    const user = userEvent.setup()
    mockApi({ tenantState: null })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit state' }))
    return { user, input: screen.getByRole('textbox', { name: /state/i }) as HTMLInputElement }
  }

  describe('Save gated while the state is empty', () => {
    itGatesQuietly(async () => {
      const { user, input } = await openEditor()
      await user.clear(input)
      return { user, button: saveButton, submitted: () => patchCalls().length }
    })
  })

  describe('Save gated while the state is whitespace', () => {
    itGatesQuietly(async () => {
      const { user, input } = await openEditor()
      await user.clear(input)
      await user.type(input, ' ')
      return { user, button: saveButton, submitted: () => patchCalls().length }
    })
  })

  it('opens with the current state, a required input, Save enabled, and no message', async () => {
    const { input } = await openEditor()
    expect(input).toHaveValue('RI')
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(saveButton()).not.toHaveAttribute('aria-disabled')
    expectMessageHidden(saveButton())
  })

  it('greys Save as soon as the state is cleared, without showing the message', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    expectQuietlyBlocked(saveButton())
    expectMessageHidden(saveButton())
  })

  it('no longer uses the old "State is required" text or an alert', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.click(saveButton())
    await user.type(input, '{Enter}')
    expect(screen.queryByText(/is required/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Enter on a blank state does not save, and reveals the message tied to the field', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expect(patchCalls()).toHaveLength(0)
    expectMessageShown(saveButton())
    expect(input).toHaveAccessibleDescription(REQUIRED_MESSAGE)
  })

  it('Enter on a whitespace-only state does not save, and reveals the message', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, ' {Enter}')
    expect(patchCalls()).toHaveLength(0)
    expectMessageShown(saveButton())
  })

  it('keeps the editor open after a refused save', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.click(saveButton())
    expect(screen.getByRole('textbox', { name: /state/i })).toBe(input)
    expect(screen.queryByRole('button', { name: 'Edit state' })).not.toBeInTheDocument()
  })

  it('hides the message once a value is entered, and then saves it', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.click(saveButton())
    expectMessageShown(saveButton())

    await user.type(input, 'TX')
    expectMessageHidden(saveButton())
    await user.click(saveButton())

    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ state: 'TX' }) }),
    ))
    expect(await screen.findByRole('button', { name: 'Edit state' })).toHaveTextContent('State: TX')
  })

  it('saves with Enter once a value is entered', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, 'tx{Enter}')
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ state: 'TX' }) }),
    ))
  })

  it('Cancel closes the editor; reopening shows no message', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expectMessageShown(saveButton())

    await user.click(cancelButton())
    expect(gateMessage()).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Edit state' }))
    await user.clear(screen.getByRole('textbox', { name: /state/i }))
    expectMessageHidden(saveButton())
  })

  it('Escape closes the editor; reopening shows no message', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '{Enter}')
    await user.type(input, '{Escape}')
    expect(gateMessage()).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Edit state' }))
    await user.clear(screen.getByRole('textbox', { name: /state/i }))
    expectMessageHidden(saveButton())
  })

  it('a refused blank state does not leave the bill-number editor showing a message', async () => {
    const { user, input } = await openEditor()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expectMessageShown(saveButton())
    await user.click(cancelButton())

    await user.click(screen.getByRole('button', { name: 'Edit bill number' }))
    await user.clear(screen.getByRole('textbox', { name: /bill number/i }))
    expectMessageHidden(saveButton())
  })
})

describe('BillDetail draft State editor (Picker): blank value', () => {
  async function openEditor() {
    const user = userEvent.setup()
    mockApi({ tenantState: null, facetStates: { RI: 3, TX: 2 } })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Edit state' }))
    const trigger = await screen.findByRole('button', { name: 'State (required)' })
    return { user, trigger }
  }

  async function chooseNone(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
    await user.click(trigger)
    fireEvent.click(screen.getByRole('radio', { name: 'Select a state…' }))
  }

  describe('Save gated with no state chosen', () => {
    itGatesQuietly(async () => {
      const { user, trigger } = await openEditor()
      await chooseNone(user, trigger)
      return { user, button: saveButton, submitted: () => patchCalls().length }
    })
  })

  it('names the State picker as required, with Save enabled and no message on open', async () => {
    const { trigger } = await openEditor()
    expect(trigger).toHaveTextContent('RI')
    expect(saveButton()).not.toHaveAttribute('aria-disabled')
    expectMessageHidden(saveButton())
  })

  it('greys Save once no state is chosen, without showing the message', async () => {
    const { user, trigger } = await openEditor()
    await chooseNone(user, trigger)
    expectQuietlyBlocked(saveButton())
    expectMessageHidden(saveButton())
  })

  it('clicking Save with no state chosen sends nothing, keeps the editor open, and shows the message', async () => {
    const { user, trigger } = await openEditor()
    await chooseNone(user, trigger)
    await user.click(saveButton())

    expect(patchCalls()).toHaveLength(0)
    expectMessageShown(saveButton())
    expect(screen.queryByText(/is required/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit state' })).not.toBeInTheDocument()
  })

  it('hides the message once a state is chosen, and then saves it', async () => {
    const { user, trigger } = await openEditor()
    await chooseNone(user, trigger)
    await user.click(saveButton())
    expectMessageShown(saveButton())

    await user.click(screen.getByRole('button', { name: 'State (required)' }))
    fireEvent.click(screen.getByRole('radio', { name: 'TX' }))
    expectMessageHidden(saveButton())

    await user.click(saveButton())
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      '/bills/42/draft',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ state: 'TX' }) }),
    ))
    expect(await screen.findByRole('button', { name: 'Edit state' })).toHaveTextContent('State: TX')
  })

  it('Cancel closes the editor; reopening shows no message', async () => {
    const { user, trigger } = await openEditor()
    await chooseNone(user, trigger)
    await user.click(saveButton())
    expectMessageShown(saveButton())

    await user.click(cancelButton())
    expect(gateMessage()).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Edit state' }))
    await chooseNone(user, await screen.findByRole('button', { name: 'State (required)' }))
    expectMessageHidden(saveButton())
  })
})
