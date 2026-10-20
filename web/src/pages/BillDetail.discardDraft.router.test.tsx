import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { BillDetail, billDetailLoader } from './BillDetail'
import { AddDraftButton } from './BillList/AddDraftButton'
import * as api from '../lib/api'
import { markJustCreatedDraft, peekJustCreatedDraft } from '../lib/justCreatedDraft'

// Discard draft through a real data router (#890): the real route config shape,
// the real billDetailLoader, and the real Add draft bill button, with only the
// network (apiFetch) and the app contexts mocked. BillDetail.discardDraft.test.tsx
// mocks the router hooks, so it cannot see what the router does on arrival: the
// loader redirects /bills/<id> to /STATE/YEAR/NUMBER (replacing location.state),
// and a reload or back/forward re-enters the same history entry.
vi.mock('../lib/scrollUtils', () => ({ getScrollContainer: () => ({ scrollTo: vi.fn() }) }))
vi.mock('../components/RichTextEditor', () => ({ RichTextEditor: () => null }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'Alice', role: 'admin', title: null, canVote: true },
    loading: false,
  }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }),
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

const server = { bill: null as Record<string, unknown> | null, deleteFails: false }

function mockApi() {
  server.bill = { ...DRAFT }
  server.deleteFails = false
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/draft' && init?.method === 'POST') return { id: '42' } as never
    if (path === '/bills/42' && init?.method === 'DELETE') {
      if (server.deleteFails) throw new api.ApiError(500, 'The draft could not be removed.')
      return { ok: true } as never
    }
    if (path === '/bills/42/draft' && init?.method === 'PATCH') {
      server.bill = { ...server.bill, ...JSON.parse(init.body as string) }
      return { ...server.bill } as never
    }
    if (path === '/bills/42' || path.startsWith('/bills/resolve/')) return { ...server.bill } as never
    if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D2', year: 2026, tenantState: 'TX' } as never
    if (path === '/bills/facets') return { state: { TX: 1 } } as never
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path === '/roles') return [] as never
    if (path === '/users') return [] as never
    return {} as never
  })
}

// The shape of App.tsx's bill routes: the same element and loader on the uuid
// route and the canonical route, with /bills as the page Discard returns to.
function makeRouter(entry: string) {
  return createMemoryRouter([
    { path: '/bills', element: <div><h1>Bills page</h1><AddDraftButton /></div> },
    { path: '/bills/:billId', element: <BillDetail />, loader: billDetailLoader },
    { path: '/:state/:sessionSlug/:billNumber', element: <BillDetail />, loader: billDetailLoader },
  ], { initialEntries: [entry] })
}

function mount(entry: string, { strict = false } = {}) {
  const router = makeRouter(entry)
  const tree = <RouterProvider router={router} />
  render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  return router
}

const deleteCalls = () => vi.mocked(api.apiFetch).mock.calls.filter(([, init]) => init?.method === 'DELETE')

beforeEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  mockApi()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
})

describe('Discard draft through the real router', () => {
  it('shows on the canonical page after Add draft bill, which opens /bills/<id> and is redirected', async () => {
    const user = userEvent.setup()
    const router = mount('/bills')

    await user.click(screen.getByRole('button', { name: 'Add draft bill' }))

    expect(await screen.findByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/TX/2026/D1')
  })

  it('shows on the canonical page for a draft opened by uuid right after it was marked', async () => {
    markJustCreatedDraft('42')
    const router = mount('/bills/42')

    expect(await screen.findByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/TX/2026/D1')
  })

  it('shows once under StrictMode, which runs effects twice', async () => {
    markJustCreatedDraft('42')
    mount('/bills/42', { strict: true })

    expect(await screen.findByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
    await waitFor(() => expect(peekJustCreatedDraft('42')).toBe(false))
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
  })

  it('is gone on a reload: a second mount at the same history entry does not show it', async () => {
    markJustCreatedDraft('42')
    const first = mount('/bills/42')
    await screen.findByRole('button', { name: 'Discard draft' })
    const entry = first.state.location.pathname
    cleanup()

    // A reload re-enters the entry the first visit ended on.
    mount(entry)
    await screen.findByText('Pre-filed draft')
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
  })

  it('is gone on a link to the same draft opened afterwards', async () => {
    markJustCreatedDraft('42')
    mount('/bills/42')
    await screen.findByRole('button', { name: 'Discard draft' })
    cleanup()

    mount('/bills/42')
    await screen.findByText('Pre-filed draft')
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
  })

  it('does not show on an ordinary visit that nothing marked', async () => {
    markJustCreatedDraft('42')
    mount('/bills/42')
    await screen.findByRole('button', { name: 'Discard draft' })
    cleanup()
    window.sessionStorage.clear()

    mount('/bills/42')
    await screen.findByText('Pre-filed draft')
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
  })

  it('stays after an in-page bill number edit, which navigates with replace', async () => {
    const user = userEvent.setup()
    markJustCreatedDraft('42')
    const router = mount('/bills/42')
    await screen.findByRole('button', { name: 'Discard draft' })

    await user.click(await screen.findByRole('button', { name: 'Edit bill number' }))
    const input = document.querySelector('input[name="draftBillNumber"]') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'D9')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/TX/2026/D9'))
    expect(await screen.findByRole('button', { name: 'Edit bill number' })).toHaveTextContent('Bill number: D9')
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
  })

  it('Discard sends DELETE /bills/<id> and lands on the bills page', async () => {
    const user = userEvent.setup()
    markJustCreatedDraft('42')
    const router = mount('/bills/42')

    await user.click(await screen.findByRole('button', { name: 'Discard draft' }))

    expect(await screen.findByRole('heading', { name: 'Bills page' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/bills')
    expect(deleteCalls()).toEqual([['/bills/42', { method: 'DELETE' }]])
  })

  it('a failed Discard shows the error and stays on the canonical draft page', async () => {
    const user = userEvent.setup()
    server.deleteFails = true
    markJustCreatedDraft('42')
    const router = mount('/bills/42')

    await user.click(await screen.findByRole('button', { name: 'Discard draft' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The draft could not be removed.')
    expect(router.state.location.pathname).toBe('/TX/2026/D1')
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeEnabled()
  })

  it('does not show for a draft reached after a different draft was marked', async () => {
    markJustCreatedDraft('43')
    mount('/bills/42')
    await screen.findByText('Pre-filed draft')
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
    // The other draft's marker is not this page's to consume.
    expect(peekJustCreatedDraft('43')).toBe(true)
  })

  it('sends one DELETE for two clicks dispatched in the same task', async () => {
    let release!: () => void
    markJustCreatedDraft('42')
    vi.mocked(api.apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/bills/42' && init?.method === 'DELETE') {
        await new Promise<void>(resolve => { release = resolve })
        return { ok: true } as never
      }
      if (path === '/bills/42' || path.startsWith('/bills/resolve/')) return { ...server.bill } as never
      if (path === '/config') return { ...CONFIG } as never
      if (path === '/bills/draft-defaults') return { billNumber: 'D2', year: 2026, tenantState: 'TX' } as never
      if (path === '/bills/facets') return { state: { TX: 1 } } as never
      return (path === '/config/custom-fields' || path === '/roles' || path === '/users' ? [] : {}) as never
    })
    mount('/bills/42')

    const button = await screen.findByRole('button', { name: 'Discard draft' })
    // Both clicks are dispatched in one task, before React can flush a re-render.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => expect(deleteCalls()).toHaveLength(1))
    release()
    await screen.findByRole('heading', { name: 'Bills page' })
    expect(deleteCalls()).toHaveLength(1)
  })
})
