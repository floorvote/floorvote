import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillDetail } from './BillDetail'
import * as api from '../lib/api'

// The previous/next bill arrows at the top right of a bill page step through the
// bills list, which is vertical (and sits beside the bill in the split layout),
// so they point up (previous) and down (next). BillDetail renders the same
// arrows in the split pane and in the full layout; the split is AppLayout's, and
// BillDetail never branches on viewport width, so the layouts are stood in for
// by a wide and a narrow viewport below.

// ── Scaffolding copied from BillDetail.statusExplainer.test.tsx ───────────────

const routerMock = vi.hoisted(() => ({
  navigate: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  navigationState: 'idle' as 'idle' | 'loading',
  params: { billId: '42' } as Record<string, string | undefined>,
  location: { state: null as unknown, pathname: '/bills/42', hash: '', search: '' } as {
    state: unknown; pathname: string; hash: string; search: string
  },
  loaderData: null as unknown,
}))
function resetRouterMock() {
  routerMock.navigate = vi.fn()
  routerMock.navigationState = 'idle'
  routerMock.params = { billId: '42' }
  routerMock.location = { state: null, pathname: '/bills/42', hash: '', search: '' }
}
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useParams: () => routerMock.params,
    useNavigate: () => routerMock.navigate,
    useNavigation: () => ({ state: routerMock.navigationState }),
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



const PATHS = ['/RI/2025-2026/HB1', '/RI/2025-2026/HB2', '/RI/2025-2026/HB3']

const LAYOUTS = [
  { layout: 'split pane (wide)', width: 1600 },
  { layout: 'full width (narrow)', width: 600 },
] as const

const realMatchMedia = window.matchMedia
function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query)
    const max = /max-width:\s*(\d+)px/.exec(query)
    const matches = min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }
  }) as unknown as typeof window.matchMedia
}

async function renderAt(currentIndex: number | null, billPaths: string[] | null = PATHS) {
  routerMock.params = { state: 'RI', sessionSlug: '2025-2026', billNumber: 'HB2' }
  routerMock.location = {
    state: billPaths && currentIndex != null ? { billPaths, currentIndex } : null,
    pathname: '/RI/2025-2026/HB2', hash: '', search: '',
  }
  routerMock.loaderData = BILL
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') return { ...CONFIG } as never
    if (path === '/config/custom-fields') return [] as never
    if (path.startsWith('/bills/labels')) return { state: 'RI', statuses: [], billTypes: [], eventTypes: [], calendarName: null, hasEvents: false } as never
    if (path.startsWith('/bills/')) return BILL as never
    return {} as never
  })
  render(<MemoryRouter><BillDetail /></MemoryRouter>)
  await screen.findByText('Test Bill')
}

beforeEach(() => {
  resetRouterMock()
  vi.restoreAllMocks()
})
afterEach(() => { window.matchMedia = realMatchMedia })

describe.each(LAYOUTS)('bill page previous and next arrows, $layout', ({ width }) => {
  beforeEach(() => setViewport(width))

  it('points the previous-bill arrow up and the next-bill arrow down', async () => {
    await renderAt(1)
    const prev = screen.getByRole('button', { name: 'Previous bill' })
    const next = screen.getByRole('button', { name: 'Next bill' })
    expect(prev.querySelector('svg[data-arrow="up"]')).not.toBeNull()
    expect(prev.querySelector('svg[data-arrow="down"]')).toBeNull()
    expect(next.querySelector('svg[data-arrow="down"]')).not.toBeNull()
    expect(next.querySelector('svg[data-arrow="up"]')).toBeNull()
  })

  it('no longer draws left or right arrows', async () => {
    await renderAt(1)
    for (const name of ['Previous bill', 'Next bill']) {
      const button = screen.getByRole('button', { name })
      expect(button.textContent).not.toMatch(/[←→]/)
      expect(button.querySelector('svg[data-arrow="left"], svg[data-arrow="right"]')).toBeNull()
    }
  })

  it('keeps the accessible names "Previous bill" and "Next bill"', async () => {
    await renderAt(1)
    expect(screen.getByRole('button', { name: 'Previous bill' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next bill' })).toBeInTheDocument()
  })

  it('keeps previous before next in the page order', async () => {
    await renderAt(1)
    const prev = screen.getByRole('button', { name: 'Previous bill' })
    const next = screen.getByRole('button', { name: 'Next bill' })
    expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('hides the arrow glyphs from assistive technology (the button carries the name)', async () => {
    await renderAt(1)
    for (const svg of screen.getAllByRole('button', { name: /(Previous|Next) bill/ }).map(b => b.querySelector('svg'))) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('has tooltips that name the action and its key, without saying left or right', async () => {
    await renderAt(1)
    const prev = screen.getByRole('button', { name: 'Previous bill' })
    const next = screen.getByRole('button', { name: 'Next bill' })
    expect(prev).toHaveAttribute('title', 'Previous bill (K)')
    expect(next).toHaveAttribute('title', 'Next bill (J)')
    expect(`${prev.title} ${next.title}`).not.toMatch(/[←→]|left|right/i)
  })

  it('steps to the previous bill in the list and passes the list context along', async () => {
    await renderAt(1)
    fireEvent.click(screen.getByRole('button', { name: 'Previous bill' }))
    expect(routerMock.navigate).toHaveBeenCalledTimes(1)
    expect(routerMock.navigate).toHaveBeenCalledWith(PATHS[0], { state: { billPaths: PATHS, currentIndex: 0 } })
  })

  it('steps to the next bill in the list and passes the list context along', async () => {
    await renderAt(1)
    fireEvent.click(screen.getByRole('button', { name: 'Next bill' }))
    expect(routerMock.navigate).toHaveBeenCalledTimes(1)
    expect(routerMock.navigate).toHaveBeenCalledWith(PATHS[2], { state: { billPaths: PATHS, currentIndex: 2 } })
  })

  it('enables both arrows in the middle of the list', async () => {
    await renderAt(1)
    expect(screen.getByRole('button', { name: 'Previous bill' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next bill' })).toBeEnabled()
  })

  it('disables only the up arrow on the first bill, and does not wrap to the last', async () => {
    await renderAt(0)
    const prev = screen.getByRole('button', { name: 'Previous bill' })
    expect(prev).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next bill' })).toBeEnabled()
    fireEvent.click(prev)
    expect(routerMock.navigate).not.toHaveBeenCalled()
  })

  it('disables only the down arrow on the last bill, and does not wrap to the first', async () => {
    await renderAt(PATHS.length - 1)
    const next = screen.getByRole('button', { name: 'Next bill' })
    expect(next).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous bill' })).toBeEnabled()
    fireEvent.click(next)
    expect(routerMock.navigate).not.toHaveBeenCalled()
  })

  it('still draws up and down arrows when disabled at the ends', async () => {
    await renderAt(0)
    expect(screen.getByRole('button', { name: 'Previous bill' }).querySelector('svg[data-arrow="up"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Next bill' }).querySelector('svg[data-arrow="down"]')).not.toBeNull()
  })

  it('shows no arrows for a list of one bill', async () => {
    await renderAt(0, [PATHS[1]])
    expect(screen.queryByRole('button', { name: 'Previous bill' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next bill' })).not.toBeInTheDocument()
  })

  it('shows no arrows when the bill was not opened from a list', async () => {
    await renderAt(null, null)
    expect(screen.queryByRole('button', { name: 'Previous bill' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next bill' })).not.toBeInTheDocument()
  })

  it('disables both arrows while a bill navigation is pending', async () => {
    routerMock.navigationState = 'loading'
    await renderAt(1)
    expect(screen.getByRole('button', { name: 'Previous bill' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next bill' })).toBeDisabled()
  })

  describe('keyboard shortcuts', () => {
    it('ArrowLeft goes to the previous bill and ArrowRight to the next', async () => {
      await renderAt(1)
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
      expect(routerMock.navigate).toHaveBeenLastCalledWith(PATHS[0], { state: { billPaths: PATHS, currentIndex: 0 } })
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      expect(routerMock.navigate).toHaveBeenLastCalledWith(PATHS[2], { state: { billPaths: PATHS, currentIndex: 2 } })
      expect(routerMock.navigate).toHaveBeenCalledTimes(2)
    })

    it('k goes to the previous bill and j to the next', async () => {
      await renderAt(1)
      fireEvent.keyDown(window, { key: 'k' })
      expect(routerMock.navigate).toHaveBeenLastCalledWith(PATHS[0], { state: { billPaths: PATHS, currentIndex: 0 } })
      fireEvent.keyDown(window, { key: 'j' })
      expect(routerMock.navigate).toHaveBeenLastCalledWith(PATHS[2], { state: { billPaths: PATHS, currentIndex: 2 } })
      expect(routerMock.navigate).toHaveBeenCalledTimes(2)
    })

    it('k does nothing on the first bill and j does nothing on the last', async () => {
      await renderAt(0)
      fireEvent.keyDown(window, { key: 'k' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
      cleanup()
      await renderAt(2)
      fireEvent.keyDown(window, { key: 'j' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
    })

    it('j and k do nothing when the bill was not opened from a list', async () => {
      await renderAt(null, null)
      fireEvent.keyDown(window, { key: 'j' })
      fireEvent.keyDown(window, { key: 'k' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
    })

    it.each([
      ['ctrl', { ctrlKey: true }],
      ['meta', { metaKey: true }],
      ['alt', { altKey: true }],
      ['shift', { shiftKey: true }],
    ])('ignores j and k with %s held', async (_name, mods) => {
      await renderAt(1)
      fireEvent.keyDown(window, { key: 'j', ...mods })
      fireEvent.keyDown(window, { key: 'k', ...mods })
      expect(routerMock.navigate).not.toHaveBeenCalled()
    })

    it.each(['input', 'textarea', 'div'])('ignores j and k while typing in a %s', async (tag) => {
      await renderAt(1)
      const el = document.createElement(tag)
      if (tag === 'div') el.setAttribute('contenteditable', 'true')
      document.body.appendChild(el)
      fireEvent.keyDown(el, { key: 'j' })
      fireEvent.keyDown(el, { key: 'k' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
      el.remove()
    })

    it('ignores j and k typed into a child of an editor', async () => {
      await renderAt(1)
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      const p = document.createElement('p')
      editor.appendChild(p)
      document.body.appendChild(editor)
      fireEvent.keyDown(p, { key: 'j' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
      editor.remove()
    })

    it('does not respond to other letters', async () => {
      await renderAt(1)
      fireEvent.keyDown(window, { key: 'h' })
      fireEvent.keyDown(window, { key: 'l' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
    })

    it('does not take over ArrowUp and ArrowDown, which scroll the page', async () => {
      await renderAt(1)
      fireEvent.keyDown(window, { key: 'ArrowUp' })
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
    })

    it('does not step past the ends of the list', async () => {
      await renderAt(0)
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
    })

    it('ignores the arrow keys while typing in a field', async () => {
      await renderAt(1)
      const input = document.createElement('input')
      document.body.appendChild(input)
      fireEvent.keyDown(input, { key: 'ArrowRight' })
      expect(routerMock.navigate).not.toHaveBeenCalled()
      input.remove()
    })
  })
})
