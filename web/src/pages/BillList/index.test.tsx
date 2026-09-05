import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'

// Renders the current pathname + hash so navigation tests can assert where a
// click landed (including the #section-* anchor on the bill detail page).
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}{loc.search}{loc.hash}</div>
}

// --- Mock the API client ----------------------------------------------------
// BillList (and the AuthProvider it renders under) talk to the backend only
// through apiFetch. We route by path and record the calls so we can assert the
// list both renders the fixture and re-fetches when a filter changes.
const apiCalls: string[] = []

// Lets a test hold the `/bills/:id` prefetch open so it can observe the
// navigation-pending window (when the body should carry the wait-cursor class).
const deferred: {
  resolveBillDetail: ((v: unknown) => void) | null
  rejectVote: ((reason?: unknown) => void) | null
} = { resolveBillDetail: null, rejectVote: null }

// Lets a test force the vote endpoint to reject so we can assert the optimistic
// vote rolls back.
const voteReject = { value: false }

// Lets a test hold the `/views` fetch open (to simulate it resolving on a
// later tick than the mount commit) and control what it eventually resolves
// with. Defaults to an immediate empty list, matching every test that doesn't
// care about saved views.
const viewsState: { deferred: boolean; response: { views: Array<{ id: string; name: string; query: string; slug?: string; previousSlug?: string | null }> } } =
  { deferred: false, response: { views: [] } }
let resolveViews: ((v: unknown) => void) | null = null

// Mutable so one test can opt into a locked demo tenant. Member votes are on the
// server's demo allowlist, so handleVote must NOT consult demoLocked — see the
// "list-page votes on a locked demo tenant" describe below.
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

const CONFIG = {
  associationName: 'Test Assoc',
  states: ['RI'],
  positionVocabulary: ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'],
  orgNoun: 'association',
}

function makeBill(over: Partial<Record<string, unknown>>) {
  return {
    id: 'b1', billNumber: 'HB 1', title: 'Default bill', state: 'RI', status: '2',
    session: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: 'Referred',
    lastActionDate: '2026-02-01', tenantSummary: null, tags: [], priority: null,
    matchType: 'keyword', position: null, relevanceScore: 80, aiProcessedAt: null,
    voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-02-01 10:00:00',
    customFieldValues: {},
    ...over,
  }
}

const BILLS = [
  makeBill({ id: 'bill-early-vote', billNumber: 'SB 2218', title: 'Early Voting Centers', status: '2', commentCount: 2, hasNote: true }),
  makeBill({ id: 'bill-voter-id', billNumber: 'HB 5042', title: 'Voter Identification Requirements', status: '1' }),
  makeBill({ id: 'bill-training', billNumber: 'SB 2500', title: 'Election Official Training', status: '4' }),
]

const FACETS = {
  status: { '1': 1, '2': 1, '4': 1 },
  priority: {},
  session: {},
  year: {},
  state: { RI: 3 },
  position: {},
  tags: {},
  subjects: { 'UT:Counties': 1 },
  customFields: {},
  myBillsCount: 0,
  newMatchesCount: 0,
}

vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'ApiError' }
  }
  async function apiFetch<T>(path: string): Promise<T> {
    apiCalls.push(path)
    if (path === '/auth/me') {
      return { id: 'demo-user', email: 'demo@example.com', name: 'Demo', role: 'owner',
        subtitle: null, canVote: true, emailDigestEnabled: false, lastSeenFeed: null } as T
    }
    if (path === '/config') return CONFIG as T
    if (path === '/users/me/bills') return [] as T
    if (path === '/config/custom-fields') return [] as T
    if (path === '/views') {
      if (viewsState.deferred) {
        return new Promise<T>(res => { resolveViews = res as (v: unknown) => void })
      }
      return viewsState.response as T
    }
    if (path.startsWith('/bills/facets')) return FACETS as T
    if (path.endsWith('/votes')) {
      // When a test wants the vote to fail, hold the rejection open (deferred) so
      // the optimistic count stays observable until the test triggers the failure
      // — otherwise the rollback can beat the assertion on a loaded CI runner.
      if (voteReject.value) {
        return new Promise<T>((_resolve, reject) => { deferred.rejectVote = reject })
      }
      return {} as T
    }
    // A single-bill prefetch (e.g. /bills/bill-early-vote) — held open so a
    // test can inspect state while navigation is pending.
    if (/^\/bills\/[^?]/.test(path)) {
      return new Promise<T>(res => { deferred.resolveBillDetail = res as (v: unknown) => void })
    }
    if (path.startsWith('/bills?')) {
      // Honor a status filter so the test can observe the list responding.
      const qs = new URLSearchParams(path.split('?')[1])
      const statuses = qs.getAll('status')
      const filtered = statuses.length > 0 ? BILLS.filter(b => statuses.includes(b.status)) : BILLS
      return { bills: filtered, pagination: { page: 1, pageSize: 100, total: filtered.length, totalPages: 1 } } as T
    }
    return {} as T
  }
  return { apiFetch, ApiError }
})

// --- Mock the virtualizer ---------------------------------------------------
// jsdom has no layout, so the real useVirtualizer measures a 0-height scroll
// element and renders no rows. Render every row instead so we can assert on it.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 150,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index, key: index, start: index * 150, size: 150,
      })),
    measureElement: () => {},
  }),
}))

import { BillList } from './index'
import { ApiError } from '../../lib/api'
import { AuthProvider } from '../../context/AuthContext'
import { SidebarRefreshProvider } from '../../context/SidebarRefreshContext'

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/bills']}>
      <AuthProvider>
        <SidebarRefreshProvider>{children}</SidebarRefreshProvider>
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>
  )
}

// Stub IntersectionObserver (infinite-scroll sentinel) — absent in jsdom.
// Use vi.stubGlobal so afterEach's unstubAllGlobals actually restores it
// (a direct globalThis assignment would leak into other test files).
class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  apiCalls.length = 0
  deferred.resolveBillDetail = null
  deferred.rejectVote = null
  voteReject.value = false
  demoState.demoLocked = false
  viewsState.deferred = false
  viewsState.response = { views: [] }
  resolveViews = null
  document.body.classList.remove('nav-pending')
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BillList vote failure rollback', () => {
  it('rolls back the optimistic vote when the vote request fails', async () => {
    voteReject.value = true
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    // First bill (Early Voting Centers) — its Support vote button + count.
    // Re-resolve the row on each check rather than caching the node: an optimistic
    // re-render can replace the row's DOM element, so a reference captured once can
    // go stale (an intermittent "unable to find 1/0" under load).
    // Scope by the row's own test hook rather than by DOM depth: walking
    // parentElement a fixed number of times silently broke when the vote button
    // gained a tooltip wrapper.
    const supportRow = () => screen.getAllByRole('button', { name: 'Support' })[0].closest('[data-testid="vote-row"]') as HTMLElement
    expect(within(supportRow()).getByText('0')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Support' })[0])
    // Optimistic update bumps the count to 1 (the failing vote request is held
    // pending by the mock, so the count stays observably at 1)...
    await waitFor(() => expect(within(supportRow()).getByText('1')).toBeInTheDocument())
    // ...now fail the request; the count must roll back to 0.
    deferred.rejectVote?.(new ApiError(500, 'fail'))
    await waitFor(() => expect(within(supportRow()).getByText('0')).toBeInTheDocument())
  })
})

describe('BillList votes on a locked demo tenant', () => {
  // Pins the handler, not the button. BillRow.test.tsx covers the vote bar being
  // enabled, but it passes its own vi.fn() for onVote, so it never reaches
  // BillList's handleVote — a reinstated `if (demoLocked) return` there would
  // make every list-page vote a silent no-op with a green suite. POST
  // /bills/:id/votes is on the server's demo allowlist; assert it actually fires.
  it('still POSTs /bills/:id/votes when the demo is locked', async () => {
    demoState.demoLocked = true
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    fireEvent.click(screen.getAllByRole('button', { name: 'Support' })[0])
    await waitFor(() => expect(apiCalls.some(p => p.endsWith('/votes'))).toBe(true))
  })
})

describe('BillList page', () => {
  it('renders the seeded bills from the API', async () => {
    render(<BillList />, { wrapper: Wrapper })

    expect(await screen.findByText('Early Voting Centers')).toBeInTheDocument()
    expect(screen.getByText('Voter Identification Requirements')).toBeInTheDocument()
    expect(screen.getByText('Election Official Training')).toBeInTheDocument()

    // Bill count reflects the full fixture.
    expect(await screen.findByText(/3 bills/)).toBeInTheDocument()

    // Column headers are fixed labels regardless of org noun.
    // The SortHeader buttons include the sort arrow indicator after the label.
    expect(screen.getAllByRole('button', { name: /^Position/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /^Relevance/ }).length).toBeGreaterThan(0)

    // Sort description uses the configured org noun via orgPositionLabel.
    // Default sort shows the full hierarchy including the position label.
    expect(screen.getByText(/Sorted by:/)).toBeInTheDocument()
  })

  // The Subject filter's tooltip replaced the old under-the-filter-row
  // "excludes states with no subjects" warning with a caveat baked into the
  // tooltip copy itself.
  it('shows the subject-assignment caveat in the Subject filter tooltip', async () => {
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    const subjectButton = await screen.findByRole('button', { name: 'Subject' })
    fireEvent.pointerEnter(subjectButton, { pointerType: 'mouse' })

    expect(await screen.findByText(
      'Filter by legislature-assigned subject. (Not all legislatures assign subjects, and those that do might assign them inconsistently.)',
    )).toBeInTheDocument()
  })

  it('re-fetches and narrows the list when a status filter is applied', async () => {
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    // Open the Status filter dropdown and pick "Passed" (LegiScan code 4),
    // which only the training bill has.
    // The filter dropdown button's accessible name is exactly "Status"
    // (the sortable column header is "Status ▲▼", so an exact match disambiguates).
    fireEvent.click(screen.getByRole('button', { name: 'Status' }))
    // "Passed" also appears on a row's status chip, so pick the dropdown option
    // specifically: the one rendered inside a <label> (checkbox row).
    const passedOption = (await screen.findAllByText('Passed'))
      .find(el => el.closest('label') !== null)
    expect(passedOption).toBeTruthy()
    fireEvent.click(passedOption!)

    // The list re-queries /bills with status=4 ...
    await waitFor(() => {
      expect(apiCalls.some(c => c.startsWith('/bills?') && c.includes('status=4'))).toBe(true)
    })

    // ... and the other two bills drop out of the list.
    await waitFor(() => {
      expect(screen.queryByText('Early Voting Centers')).toBeNull()
    })
    expect(screen.getByText('Election Official Training')).toBeInTheDocument()
  })

  // (The "nav-pending while opening a bill" test was removed with the custom nav
  // layer — the wait cursor is now driven by the router's navigation state via
  // useNavPendingCursor; see useNavPendingCursor.test.tsx. Clicking a bill now
  // navigates straight through the router, so the indicator tests below no longer
  // hold a prefetch open.)

  it('comment indicator navigates to the bill comments section', async () => {
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    fireEvent.click(screen.getByRole('button', { name: /2 comments/ }))

    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toContain('#section-comments')
    })
  })

  it('personal note indicator navigates to the bill note section', async () => {
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    fireEvent.click(screen.getByRole('button', { name: /Personal note/ }))

    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toContain('#section-note')
    })
  })
})

describe('BillList bookmarked view slug', () => {
  // Regression for: savedViews starts as [] and is populated by an async
  // /views fetch, so the stale-slug effect used to run during the mount
  // commit — before that fetch resolved — see no matching view, and clear
  // the `view` param permanently (it never got a second look once the fetch
  // landed, because activeViewSlug was already gone). A bookmarked
  // ?view=<id> URL must survive past that fetch resolving, and once it does,
  // the switcher must show the matched view as active.
  it('keeps the view param across a /views fetch that resolves after mount', async () => {
    const VIEW = { id: 'v1', name: 'Clerk bills', query: 'subject=UT%3AElections' }
    viewsState.deferred = true

    render(
      <MemoryRouter initialEntries={['/bills?view=v1&subject=UT%3AElections']}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByText('Early Voting Centers')

    // The /views fetch is still pending — flush a tick so any effect that
    // runs before it resolves (the bug) has had its chance.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.getByTestId('loc').textContent).toContain('view=v1')

    // Now let /views resolve with the matching view.
    resolveViews?.({ views: [VIEW] })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /clerk bills/i })).toBeTruthy()
    })
    expect(screen.getByTestId('loc').textContent).toContain('view=v1')
  })
})

describe('BillList saved views — search interaction', () => {
  it('does not offer "Save as view" when only a search term is active — search never reaches the URL', async () => {
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'voting' } })

    expect(screen.queryByRole('button', { name: /save as view/i })).toBeNull()
  })

  it('clears an active search term when a view is applied', async () => {
    viewsState.response = { views: [{ id: 'v1', name: 'Passed bills', query: 'status=4' }] }
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    const search = screen.getByPlaceholderText('Search…') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'voting' } })
    expect(search.value).toBe('voting')

    fireEvent.click(await screen.findByRole('button', { name: /views/i }))
    fireEvent.click(await screen.findByText('Passed bills'))

    await waitFor(() => expect(search.value).toBe(''))
  })

  it('clears an active search term when "All bills" is applied', async () => {
    viewsState.response = { views: [{ id: 'v1', name: 'Passed bills', query: 'status=4' }] }
    render(<BillList />, { wrapper: Wrapper })
    await screen.findByText('Early Voting Centers')

    const search = screen.getByPlaceholderText('Search…') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'voting' } })
    expect(search.value).toBe('voting')

    fireEvent.click(await screen.findByRole('button', { name: /views/i }))
    fireEvent.click(await screen.findByText('All bills'))

    await waitFor(() => expect(search.value).toBe(''))
  })
})

describe('BillList saved views — short URL resolution', () => {
  it('loading ?view=<id> cold applies that view\'s filters and keeps the URL short', async () => {
    viewsState.response = { views: [{ id: 'v1', name: 'Passed bills', query: 'status=4' }] }

    render(
      <MemoryRouter initialEntries={['/bills?view=v1']}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /passed bills/i })).toBeTruthy()
    })
    await waitFor(() => {
      expect(screen.queryByText('Early Voting Centers')).toBeNull()
    })
    expect(screen.getByText('Election Official Training')).toBeInTheDocument()

    const loc = screen.getByTestId('loc').textContent!
    expect(loc).toContain('view=v1')
    expect(loc).not.toContain('status=')
  })

  it('expands the URL and clears view once a filter changes after applying one', async () => {
    viewsState.response = { views: [{ id: 'v1', name: 'Passed bills', query: 'status=4' }] }

    render(
      <MemoryRouter initialEntries={['/bills?view=v1']}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /passed bills/i })).toBeTruthy()
    })

    // findByRole (not getByRole): the Status dropdown mounts once facets load,
    // a separate fetch from the /views one the waitFor above is gated on —
    // under load the two don't always resolve on the same tick.
    fireEvent.click(await screen.findByRole('button', { name: 'Status' }))
    const introducedOption = (await screen.findAllByText('Introduced'))
      .find(el => el.closest('label') !== null)
    fireEvent.click(introducedOption!)

    await waitFor(() => {
      const loc = screen.getByTestId('loc').textContent!
      expect(loc).not.toContain('view=')
      expect(loc).toContain('status=')
    })
    expect(screen.getByRole('button', { name: /^views$/i })).toBeTruthy()
  })

  it('clears a ?view=<id> naming a nonexistent view once views have loaded', async () => {
    viewsState.response = { views: [] }

    render(
      <MemoryRouter initialEntries={['/bills?view=ghost']}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByText('Early Voting Centers')

    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).not.toContain('view=')
    })
  })
})

describe('BillList search-term hint', () => {
  it('warns when a search term is too long, and clears it otherwise', async () => {
    render(<Wrapper><BillList /></Wrapper>)
    await screen.findByText('Early Voting Centers')   // fixture list loaded
    const search = screen.getByPlaceholderText('Search…')

    fireEvent.change(search, { target: { value: 'a'.repeat(60) } })
    expect(screen.getByText(/shortened/i)).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'voting' } })
    expect(screen.queryByText(/shortened/i)).not.toBeInTheDocument()
  })

  it('warns when there are too many search terms', async () => {
    render(<Wrapper><BillList /></Wrapper>)
    await screen.findByText('Early Voting Centers')
    const search = screen.getByPlaceholderText('Search…')

    fireEvent.change(search, { target: { value: Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ') } })
    expect(screen.getByText(/first 12 terms/i)).toBeInTheDocument()
  })
})

// Regression: a view whose query contains a cf_ (custom field) filter used to be
// dropped on apply. cf_ params live in the URL rather than in hook state, so
// applyView wrote them through a second setSearchParams call that raced the sync
// effect — the view's cf_ constraint never reached the bills query, and the
// self-comparison then failed, so the view was judged "diverged" instantly.
describe('BillList saved views — applying a view from the switcher', () => {
  it('applies a cf_ filter from the view, collapses the URL, and labels the switcher', async () => {
    viewsState.response = { views: [{ id: 'v1', name: 'Passed bills', query: 'cf_acet_is_tracking=1&state=NJ&subject=NJ%3AState+Government%2C+Wagering%2C+Tourism+%26+Historic+Preservation' }] }

    render(
      <MemoryRouter initialEntries={['/bills']}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    // Switcher is present (views loaded) and resting.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^views$/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /^views$/i }))
    fireEvent.click(await screen.findByText('Passed bills'))

    await waitFor(() => {
      const loc = screen.getByTestId('loc').textContent!
      expect(loc).toContain('view=v1')
    })
    expect(screen.getByRole('button', { name: /passed bills/i })).toBeTruthy()

    // The point of the fix isn't just a tidy URL — the view's cf_ filter must
    // actually reach the bills query. Assert on the recorded /bills? request
    // (same style as the status=4 assertion above) rather than the URL, since
    // the URL legitimately collapses to the short ?view=v1 form.
    await waitFor(() => {
      expect(apiCalls.some(c => c.startsWith('/bills?') && c.includes('cf_acet_is_tracking=1'))).toBe(true)
    })
  })

  // The bookmark URL should carry the human-readable slug, not the view's
  // internal UUID — that's the whole point of adding slugs.
  it('puts the slug, not the UUID, in the URL when a view with both is applied', async () => {
    viewsState.response = { views: [{ id: '3f6a1c2e-9b3d-4c1a-8e2f-2a5b6c7d8e9f', name: 'Passed bills', slug: 'passed-bills', query: 'status=4' }] }

    render(
      <MemoryRouter initialEntries={['/bills']}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /^views$/i }))
    fireEvent.click(await screen.findByText('Passed bills'))

    await waitFor(() => {
      const loc = screen.getByTestId('loc').textContent!
      expect(loc).toContain('view=passed-bills')
      expect(loc).not.toContain('3f6a1c2e-9b3d-4c1a-8e2f-2a5b6c7d8e9f')
    })
  })
})

// A view's bookmark URL used to be the raw UUID before slugs existed, and
// staging already has those links out in the wild — they must keep resolving
// even though the switcher now always writes the slug going forward.
describe('BillList saved views — legacy UUID bookmark', () => {
  it('resolves a ?view=<uuid> URL to the matching view even though the view now has a slug', async () => {
    const UUID = '3f6a1c2e-9b3d-4c1a-8e2f-2a5b6c7d8e9f'
    viewsState.response = { views: [{ id: UUID, name: 'Passed bills', slug: 'passed-bills', query: 'status=4' }] }

    render(
      <MemoryRouter initialEntries={[`/bills?view=${UUID}`]}>
        <AuthProvider>
          <SidebarRefreshProvider><BillList /></SidebarRefreshProvider>
          <LocationProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /passed bills/i })).toBeTruthy()
    })
    await waitFor(() => {
      expect(screen.queryByText('Early Voting Centers')).toBeNull()
    })
    expect(screen.getByText('Election Official Training')).toBeInTheDocument()
  })
})
