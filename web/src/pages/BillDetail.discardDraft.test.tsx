import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'
import { markJustCreatedDraft, peekJustCreatedDraft } from '../lib/justCreatedDraft'

// Discard draft (#890): an admin who lands on a draft's page straight from the
// bills page's "Add draft bill" button gets a one-click undo at the top of the
// page. The just-created marker is a sessionStorage entry the page consumes on
// arrival (lib/justCreatedDraft.ts), so a reload, a link, or an ordinary visit
// never shows it. Harness mirrors BillDetail.draftState.test.tsx, with the
// router hooks mocked and auth and demo state steerable; the real router path
// (loader redirect, reload) is in BillDetail.discardDraft.router.test.tsx.
const navigateMock = vi.hoisted(() => vi.fn())
const routerMock = vi.hoisted(() => ({
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' },
  loaderData: null as unknown,
}))
const authMock = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'member' }))
const demoState = vi.hoisted(() => ({ demoLocked: false }))
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
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: authMock.role, title: null, canVote: true },
    loading: false,
  }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked, settled: true, demoResetAt: 'epoch-1' }),
}))
vi.mock('../context/SidebarRefreshContext', () => ({ useSidebarRefresh: () => vi.fn() }))
vi.mock('../context/NotificationsContext', () => ({
  useNotifications: () => ({ unreadCount: 0, notifications: [], refresh: vi.fn(async () => {}) }),
}))
vi.mock('../hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

const DRAFT = {
  id: '42',
  externalId: null,
  billNumber: 'D1',
  title: 'Pre-filed draft',
  state: 'TX',
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
  states: ['TX'],
  instanceDomains: {},
  orgNoun: 'association',
}

const FILED = { isDraft: false, externalId: 'ext-1', status: '1', session: '2026 Regular Session' }

type Delete = () => Promise<unknown>

/** @param overrides fields of the bill the page loads (a filed bill: FILED).
 *  @param onDelete what DELETE /bills/42 does: resolve, or throw an ApiError. */
function mockApi(overrides: Record<string, unknown> = {}, onDelete: Delete = async () => ({ ok: true })) {
  const bill = { ...DRAFT, ...overrides }
  routerMock.loaderData = bill
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/42' && init?.method === 'DELETE') return (await onDelete()) as never
    if (path === '/bills/42' || path.startsWith('/bills/resolve/')) return { ...bill } as never
    if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D2', year: 2026, tenantState: 'TX' } as never
    if (path === '/bills/facets') return { state: { TX: 1 } } as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

function renderPage() {
  return render(<MemoryRouter><BillDetail /></MemoryRouter>)
}

const discard = () => screen.queryByRole('button', { name: 'Discard draft' })
const deleteCalls = () => vi.mocked(api.apiFetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')

// A negative test is only meaningful if the same page does show the button when
// it should, so each one first renders the page it would otherwise be a no-op
// against: an admin's draft reached with the just-created state.
async function expectControlShowsDiscard() {
  const saved = { role: authMock.role, locked: demoState.demoLocked }
  markJustCreatedDraft('42')
  authMock.role = 'admin'
  demoState.demoLocked = false
  mockApi()
  renderPage()
  expect(await screen.findByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
  cleanup()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  authMock.role = saved.role
  demoState.demoLocked = saved.locked
}

/** Waits for the page's own content, so "absent" means "not offered", not "not drawn yet". */
async function pageHasRendered(billNumber = 'D1') {
  await screen.findByText(billNumber)
  await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/config')))
}

beforeEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  navigateMock.mockClear()
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
  authMock.role = 'admin'
  demoState.demoLocked = false
})
afterEach(() => { vi.restoreAllMocks(); window.sessionStorage.clear() })

describe('BillDetail Discard draft', () => {
  describe('when it shows', () => {
    it('shows for an admin on a draft reached with the just-created router state', async () => {
      markJustCreatedDraft('42')
      mockApi()
      renderPage()
      expect(await screen.findByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
    })

    it('does not show on the same draft when nothing marked it, as after a reload or a link', async () => {
      await expectControlShowsDiscard()
      mockApi()
      renderPage()
      await pageHasRendered()
      expect(discard()).toBeNull()
    })

    it('does not show on router state alone: the bill-list navigation state, or the old router-state marker', async () => {
      await expectControlShowsDiscard()
      routerMock.location.state = { billPaths: ['/bills/42', '/bills/43'], currentIndex: 0, justCreatedDraft: true }
      mockApi()
      renderPage()
      await pageHasRendered()
      expect(discard()).toBeNull()
    })

    it("does not show when another draft was the one just created", async () => {
      await expectControlShowsDiscard()
      markJustCreatedDraft('43')
      mockApi()
      renderPage()
      await pageHasRendered()
      expect(discard()).toBeNull()
    })

    it('does not show on a filed bill, even with the just-created state', async () => {
      await expectControlShowsDiscard()
      markJustCreatedDraft('42')
      mockApi(FILED)
      renderPage()
      await pageHasRendered()
      expect(discard()).toBeNull()
    })

    it('does not show for a member, who cannot delete a draft', async () => {
      await expectControlShowsDiscard()
      authMock.role = 'member'
      markJustCreatedDraft('42')
      mockApi()
      renderPage()
      await pageHasRendered()
      expect(discard()).toBeNull()
    })

    it('consumes the marker on arrival, so the next visit finds none', async () => {
      markJustCreatedDraft('42')
      mockApi()
      renderPage()
      await screen.findByRole('button', { name: 'Discard draft' })
      await waitFor(() => expect(peekJustCreatedDraft('42')).toBe(false))
      expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
    })

    it('does not show on a second mount of the page, as after a reload', async () => {
      markJustCreatedDraft('42')
      mockApi()
      renderPage()
      await screen.findByRole('button', { name: 'Discard draft' })
      cleanup()

      renderPage()
      await pageHasRendered()
      expect(discard()).toBeNull()
    })

    it('does not show, and does not throw, when sessionStorage is blocked', async () => {
      await expectControlShowsDiscard()
      const boom = () => { throw new DOMException('blocked', 'SecurityError') }
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
      mockApi()
      renderPage()
      await pageHasRendered()
      expect(discard()).toBeNull()
    })

    it('shows above the bill card, at the top of the page', async () => {
      markJustCreatedDraft('42')
      mockApi()
      renderPage()
      const button = await screen.findByRole('button', { name: 'Discard draft' })
      const title = await screen.findByText('Pre-filed draft')
      expect(button.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  describe('clicking it', () => {
    it('sends DELETE /bills/<id> with no confirm prompt, then returns to the bills page', async () => {
      const user = userEvent.setup()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      markJustCreatedDraft('42')
      mockApi()
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Discard draft' }))

      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/bills'))
      expect(deleteCalls()).toEqual([['/bills/42', { method: 'DELETE' }]])
      expect(confirm).not.toHaveBeenCalled()
    })

    it('does not navigate until the delete has finished', async () => {
      const user = userEvent.setup()
      let finish!: () => void
      markJustCreatedDraft('42')
      mockApi({}, () => new Promise(resolve => { finish = () => resolve({ ok: true }) }))
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Discard draft' }))
      await waitFor(() => expect(deleteCalls()).toHaveLength(1))
      expect(navigateMock).not.toHaveBeenCalled()

      finish()
      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/bills'))
    })

    it('sends one DELETE when clicked twice in a row', async () => {
      let finish!: () => void
      markJustCreatedDraft('42')
      mockApi({}, () => new Promise(resolve => { finish = () => resolve({ ok: true }) }))
      renderPage()

      const button = await screen.findByRole('button', { name: 'Discard draft' })
      fireEvent.click(button)
      fireEvent.click(button)
      await waitFor(() => expect(deleteCalls()).toHaveLength(1))
      finish()

      await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1))
      expect(deleteCalls()).toHaveLength(1)
    })

    it("shows the server's message on a failed delete and stays on the draft", async () => {
      const user = userEvent.setup()
      markJustCreatedDraft('42')
      mockApi({}, async () => { throw new api.ApiError(500, 'The draft could not be removed.') })
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Discard draft' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('The draft could not be removed.')
      expect(navigateMock).not.toHaveBeenCalled()
      expect(screen.getByText('Pre-filed draft')).toBeInTheDocument()
    })

    it('says "Failed to discard draft." when the failure carries no message', async () => {
      const user = userEvent.setup()
      markJustCreatedDraft('42')
      mockApi({}, async () => { throw new TypeError('network down') })
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Discard draft' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to discard draft.')
      expect(navigateMock).not.toHaveBeenCalled()
    })

    it('lets the admin try again after a failed delete, and clears the error when they do', async () => {
      const user = userEvent.setup()
      let fail = true
      markJustCreatedDraft('42')
      mockApi({}, async () => {
        if (fail) throw new api.ApiError(500, 'The draft could not be removed.')
        return { ok: true }
      })
      renderPage()

      await user.click(await screen.findByRole('button', { name: 'Discard draft' }))
      await screen.findByRole('alert')
      expect(screen.getByRole('button', { name: 'Discard draft' })).toBeEnabled()

      fail = false
      await user.click(screen.getByRole('button', { name: 'Discard draft' }))

      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/bills'))
      expect(screen.queryByRole('alert')).toBeNull()
      expect(deleteCalls()).toHaveLength(2)
    })
  })

  describe('in a locked demo', () => {
    it('is disabled and says "Locked in demo mode" in its title', async () => {
      demoState.demoLocked = true
      markJustCreatedDraft('42')
      mockApi()
      renderPage()

      const button = await screen.findByRole('button', { name: 'Discard draft' })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', 'Locked in demo mode')
    })

    it('sends nothing when clicked', async () => {
      demoState.demoLocked = true
      markJustCreatedDraft('42')
      mockApi()
      renderPage()

      fireEvent.click(await screen.findByRole('button', { name: 'Discard draft' }))

      expect(deleteCalls()).toHaveLength(0)
      expect(navigateMock).not.toHaveBeenCalled()
    })

    it('is enabled, with no title, when the demo is not locked', async () => {
      markJustCreatedDraft('42')
      mockApi()
      renderPage()
      const button = await screen.findByRole('button', { name: 'Discard draft' })
      expect(button).toBeEnabled()
      expect(button).not.toHaveAttribute('title')
    })
  })

  describe("the overflow menu's Delete this draft bill", () => {
    it('still asks for confirmation before deleting, on a just-created draft', async () => {
      const user = userEvent.setup()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      markJustCreatedDraft('42')
      mockApi()
      renderPage()

      await screen.findByRole('button', { name: 'Discard draft' })
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      await user.click(screen.getByRole('menuitem', { name: /Delete this draft bill/ }))

      expect(confirm).toHaveBeenCalledTimes(1)
      expect(deleteCalls()).toHaveLength(0)
    })

    it('is disabled in a locked demo, and clicking it neither prompts nor deletes', async () => {
      const user = userEvent.setup()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      demoState.demoLocked = true
      mockApi()
      renderPage()

      await pageHasRendered()
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      const item = screen.getByRole('menuitem', { name: /Delete this draft bill/ })
      expect(item).toBeDisabled()
      await user.click(item)

      expect(confirm).not.toHaveBeenCalled()
      expect(deleteCalls()).toHaveLength(0)
    })

    it("describes what the server's guard does, not a removal of votes, positions, comments, and notes", async () => {
      const user = userEvent.setup()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      mockApi()
      renderPage()

      await pageHasRendered()
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      const item = screen.getByRole('menuitem', { name: /Delete this draft bill/ })
      expect(item).toHaveTextContent(/can.?t be deleted; link it to its filed bill instead/)
      expect(item).not.toHaveTextContent(/removes it and its votes/)
      await user.click(item)

      const message = confirm.mock.calls[0][0] as string
      expect(message).toMatch(/can.?t be deleted; link it to its filed bill instead/)
      expect(message).not.toMatch(/removes it and its votes/)
    })

    it("shows the server's refusal and stays on the page when the draft has engagement (409)", async () => {
      const user = userEvent.setup()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      mockApi({}, async () => { throw new api.ApiError(409, 'This draft has engagement; link it to a filed bill instead.') })
      renderPage()

      await pageHasRendered()
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      await user.click(screen.getByRole('menuitem', { name: /Delete this draft bill/ }))

      expect(await screen.findByRole('alert')).toHaveTextContent('This draft has engagement; link it to a filed bill instead.')
      expect(navigateMock).not.toHaveBeenCalled()
      expect(screen.getByRole('menuitem', { name: /Delete this draft bill/ })).toBeEnabled()
    })

    it('says so plainly when the delete fails for another reason', async () => {
      const user = userEvent.setup()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      mockApi({}, async () => { throw new Error('network down') })
      renderPage()

      await pageHasRendered()
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      await user.click(screen.getByRole('menuitem', { name: /Delete this draft bill/ }))

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to delete draft.')
      expect(navigateMock).not.toHaveBeenCalled()
    })

    it('still deletes after a confirmed prompt on a draft reached without the state', async () => {
      const user = userEvent.setup()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      mockApi()
      renderPage()

      await pageHasRendered()
      await user.click(screen.getByRole('button', { name: 'More actions' }))
      await user.click(screen.getByRole('menuitem', { name: /Delete this draft bill/ }))

      await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/bills'))
      expect(deleteCalls()).toHaveLength(1)
    })
  })
})
