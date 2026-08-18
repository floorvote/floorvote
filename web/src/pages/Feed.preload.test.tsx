import { StrictMode } from 'react'
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

const apiCalls: string[] = []
// The signal retryFetch handed each attempt, so a test can assert that a
// discarded loader run was actually cancelled and not just forgotten.
const apiSignals: (AbortSignal | undefined)[] = []
// `gate`, when set, holds every apiFetch open until the test opens it — that is
// how the loader-race tests below decide whether the fetch beats UNBLOCK_AT_MS.
let gate: Promise<void> | null = null
vi.mock('../lib/api', () => ({
  apiFetch: async (path: string, init?: { signal?: AbortSignal }) => {
    apiCalls.push(path)
    apiSignals.push(init?.signal)
    if (gate) await gate
    return { events: [], total: 0, page: 1, limit: 40 }
  },
  ApiError: class extends Error {},
}))
// FeedUnread + auth contexts are consumed by Feed; stub to no-ops.
vi.mock('../context/FeedUnreadContext', () => ({
  useFeedUnread: () => ({ markSeen: () => {}, endVisit: () => {}, lastSeenFeed: null, initialized: true }),
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

import { FeedPane, feedLoader } from './Feed'

// A never-opened gate would leave a retryFetch loop (and its visibilitychange /
// online listeners) alive across files, so every test releases it here.
afterEach(() => { gate = null; apiSignals.length = 0 })

// feedLoader now reads RR7's request.signal, so a direct call needs the args
// the router would have passed.
const loaderArgs = () => ({ request: new Request('http://localhost/') })

// FeedEvent shape from shared/feedUtils.ts — all required fields must be present
// so groupEventsByBillAndDay renders the card with billTitle.
// Using type 'priority_set' (non-passive) so filterPriorityEvents passes the group through.
const PRELOADED = {
  events: [{
    id: 'e1',
    type: 'priority_set' as const,
    billId: 'b1',
    billNumber: 'HB 1',
    billTitle: 'Seeded Bill',
    billSessionSlug: null,
    billState: 'RI',
    billSummary: null,
    billPriority: null,
    billMatchType: null as null,
    userId: 'u1',
    userName: 'Test User',
    userSubtitle: null,
    metadata: {},
    createdAt: '2026-02-01 10:00:00',
  }],
  total: 1, page: 1, limit: 40,
}

it('renders the loader-provided feed without a loading flash or a refetch', async () => {
  apiCalls.length = 0
  // The race resolved before the unblock deadline (here, straight from the
  // fixture), so FeedPane hands Feed the data and Feed must not refetch page 1.
  const router = createMemoryRouter(
    [{ path: '/', element: <FeedPane />, loader: () => ({ data: PRELOADED }) }],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  expect(await screen.findByText('Seeded Bill')).toBeInTheDocument()
  expect(screen.queryByText('Loading…')).toBeNull()
  // The page must NOT immediately refetch page 1 when the loader already seeded it.
  expect(apiCalls.some(c => c.startsWith('/feed?page=1'))).toBe(false)
})

// The two tests below bracket UNBLOCK_AT_MS from either side. The first holds
// the fetch open for a real 120ms rather than letting it settle in a microtask:
// a microtask beats even `setTimeout(…, 0)`, so an instantly-resolving mock
// would pass no matter how short the deadline was and pin nothing.
it('resolves to data when the fetch beats the unblock deadline', async () => {
  gate = new Promise<void>((r) => { setTimeout(r, 120) })
  const result = await feedLoader(loaderArgs())
  expect(result).toHaveProperty('data')
  expect(result).not.toHaveProperty('pending')
})

it('resolves to a pending handle when the fetch misses the unblock deadline', async () => {
  let open: () => void = () => {}
  gate = new Promise<void>((r) => { open = r })
  const race = feedLoader(loaderArgs())
  // Real timers: fake ones would also have to stand in for AbortSignal.timeout,
  // which vitest does not patch. 450ms is one test, not a suite-wide cost.
  await new Promise((r) => setTimeout(r, 450))
  const result = await race
  expect(result).toHaveProperty('pending')
  expect(result).not.toHaveProperty('data')
  open()
  // The handle's promise is the same in-flight fetch, and it still settles.
  await expect((result as { pending: Promise<unknown> }).pending).resolves.toBeTruthy()
})

it('unblocks with a pending promise when the fetch is slow, then renders the feed', async () => {
  let resolveFeed: (v: typeof PRELOADED) => void = () => {}
  const pending = new Promise<typeof PRELOADED>((r) => { resolveFeed = r })
  const router = createMemoryRouter(
    [{
      path: '/',
      element: <FeedPane />,
      loader: () => ({ pending, progress: { current: null }, abort: () => {} }),
    }],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  expect(screen.queryByText('Seeded Bill')).toBeNull()
  resolveFeed(PRELOADED)
  expect(await screen.findByText('Seeded Bill')).toBeInTheDocument()
})

// "Retry now" revalidates, and a revalidation that succeeds inside the unblock
// window comes back as a *resolved* result. The pane has to pick that up — state
// seeded once from the first render's result never would, and the retry would
// appear to do nothing but blank the feed.
it('renders the feed when a revalidation replaces a pending result with data', async () => {
  let calls = 0
  const abort = vi.fn()
  const pending = new Promise<typeof PRELOADED>(() => {})
  const router = createMemoryRouter(
    [{
      path: '/',
      element: <FeedPane />,
      loader: () => (++calls === 1
        ? { pending, progress: { current: null }, abort }
        : { data: PRELOADED }),
    }],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  await screen.findByRole('img', { name: 'Loading' })
  await act(async () => { await router.revalidate() })
  expect(await screen.findByText('Seeded Bill')).toBeInTheDocument()
  // The superseded pending result must not be left retrying behind the feed.
  await waitFor(() => expect(abort).toHaveBeenCalledOnce())
})

it('aborts the retry loop when the pane unmounts', async () => {
  const abort = vi.fn()
  const pending = new Promise<typeof PRELOADED>(() => {})
  const router = createMemoryRouter(
    [{ path: '/', element: <FeedPane />, loader: () => ({ pending, progress: { current: null }, abort }) }],
    { initialEntries: ['/'] },
  )
  const { unmount } = render(<RouterProvider router={router} />)
  await screen.findByRole('img', { name: 'Loading' })
  unmount()
  // Deferred by a tick (see FeedPane) so StrictMode's remount can call it off.
  await waitFor(() => expect(abort).toHaveBeenCalledOnce())
})

// StrictMode mounts, tears down, and remounts effects. An abort fired inline
// from that teardown kills the live fetch, which rejects AbortError straight
// into the error boundary — dev-only, but it breaks the exact slow path this
// feature exists to make graceful, so it needs its own test.
it('survives StrictMode double-invoked effects on the slow path', async () => {
  const controller = new AbortController()
  let resolveFeed: (v: typeof PRELOADED) => void = () => {}
  const pending = new Promise<typeof PRELOADED>((resolve, reject) => {
    resolveFeed = resolve
    // Aborting really does reject the in-flight fetch, as retryFetch's would.
    controller.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
  const router = createMemoryRouter(
    [{
      path: '/',
      element: <FeedPane />,
      errorElement: <div>BOUNDARY</div>,
      loader: () => ({ pending, progress: { current: null }, abort: () => controller.abort() }),
    }],
    { initialEntries: ['/'] },
  )
  render(<StrictMode><RouterProvider router={router} /></StrictMode>)
  await screen.findByRole('img', { name: 'Loading' })
  // Past the deferred abort's tick — if it fired, the loop is already dead.
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  expect(controller.signal.aborted).toBe(false)

  resolveFeed(PRELOADED)
  expect(await screen.findByText('Seeded Bill')).toBeInTheDocument()
  expect(screen.queryByText('BOUNDARY')).toBeNull()
})

// Mashing "Retry now" during an outage fires overlapping revalidations. Every
// superseded run must be cancelled: retryFetch retries forever on a 30s-capped
// backoff, so each leaked run is a permanent background loop holding
// visibilitychange/online listeners. RR7 aborts request.signal for exactly
// these discarded runs, which is why feedLoader has to honour it.
it('aborts every superseded loader run when revalidation is mashed', async () => {
  apiCalls.length = 0
  let open: () => void = () => {}
  gate = new Promise<void>((r) => { open = r })
  const router = createMemoryRouter(
    [{ path: '/', element: <FeedPane />, loader: feedLoader }],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
  await screen.findByRole('img', { name: 'Loading' })

  await act(async () => {
    router.revalidate()
    router.revalidate()
    await router.revalidate()
  })
  await waitFor(() => expect(apiSignals.length).toBeGreaterThanOrEqual(3))

  // Every run but the one that survived to commit must be aborted.
  const superseded = apiSignals.slice(0, -1)
  expect(superseded.length).toBeGreaterThanOrEqual(2)
  // Spelled out per run, and given a timeout under the test's own, because the
  // bare form of this failure is `Test timed out in 5000ms` — which says only
  // that something never aborted, not which run, nor whether any aborted at
  // all. A future regression here should read as a diagnosis, not a flake.
  await waitFor(
    () => {
      const stillOpen = superseded.flatMap((s, i) => (s?.aborted ? [] : [`#${i}`]))
      expect(
        stillOpen,
        `superseded loader runs left un-aborted: ${stillOpen.join(', ') || 'none'} ` +
        `(abort state per run, last one is the committed run and is expected to stay open: ` +
        `${apiSignals.map((s, i) => `#${i}=${s?.aborted ? 'aborted' : 'open'}`).join(' ')})`,
      ).toEqual([])
    },
    { timeout: 2_000 },
  )
  open()
})
