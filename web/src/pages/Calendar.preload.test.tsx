import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, type LoaderFunctionArgs } from 'react-router-dom'

const apiCalls: string[] = []
// The signal retryFetch handed each attempt, so a test can assert that a
// discarded loader run was actually cancelled and not just forgotten.
//
// Recorded with its path, and always selected by path rather than by index:
// the rendered Calendar has its own background traffic (SubscribeCalendar's
// /calendar/info among it), and an effect-driven fetch from a previous test can
// still land in here after that test's afterEach on a contended runner. Indexing
// into this array made a correct test fail about 1 run in 20 of the full suite.
const apiSignals: { path: string; signal?: AbortSignal }[] = []
const attemptsFor = (path: string) => apiSignals.filter((s) => s.path === path)
// `gate`, when set, holds every apiFetch open until the test opens it — or until
// the attempt's own signal aborts, which is how a real fetch fails and what lets
// retryFetch's loop notice a cancelled run instead of hanging on the mock.
let gate: Promise<void> | null = null
let openGate: (() => void) | null = null
vi.mock('../lib/api', () => ({
  apiFetch: async (path: string, init?: { signal?: AbortSignal }) => {
    apiCalls.push(path)
    apiSignals.push({ path, signal: init?.signal })
    if (gate) {
      await Promise.race([
        gate,
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
      ])
    }
    if (path === '/config') return { states: ['RI'] }
    if (path === '/calendar/events') return []
    return []
  },
  ApiError: class extends Error {},
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'member' } }) }))

import { Calendar, calendarLoader } from './Calendar'

// A still-held gate would leave a retryFetch loop (and its visibilitychange /
// online listeners) alive across files, so release it here unconditionally —
// nulling `gate` alone does not settle an await already parked on it.
afterEach(() => { openGate?.(); openGate = null; gate = null; apiSignals.length = 0 })

// Fixture uses real CalendarEvent shape — "description" is the rendered title field
// (eventBodyModel derives text from event.description, not a "title" property).
const PRELOADED = [{
  id: 'c1',
  uid: 'uid-c1',
  source: 'hearing',
  description: 'Seeded Hearing',
  date: '2026-02-15',
  time: null,
  location: null,
  details: null,
  url: null,
  billId: null,
  bills: [],
  status: 'confirmed' as const,
}]

it('renders loader-provided calendar events without re-fetching /calendar/events', async () => {
  apiCalls.length = 0
  // The route loader resolves events before render (here from the fixture), so the
  // component seeds from useLoaderData and must not refetch /calendar/events.
  const router = createMemoryRouter(
    [{ path: '/calendar', element: <Calendar />, loader: () => PRELOADED }],
    { initialEntries: ['/calendar'] },
  )
  render(<RouterProvider router={router} />)
  expect(await screen.findByText('Seeded Hearing')).toBeInTheDocument()
  expect(apiCalls).not.toContain('/calendar/events')
})

// apiFetchForLoader retries indefinitely (retryFetch has no attempt cap by
// design), so a loader run that nothing cancels becomes a permanent background
// loop hammering an already-struggling backend and holding
// visibilitychange/online listeners. RR7 aborts request.signal for exactly the
// runs that never commit — an abandoned /calendar navigation, a superseded
// revalidation — which is why calendarLoader has to thread it through.
it('aborts the retry loop when the navigation that started it is abandoned', async () => {
  // Held open for the whole test; the afterEach releases it so a regression
  // here cannot leak a live retry loop into the next file.
  gate = new Promise<void>((resolve) => { openGate = resolve })
  const controller = new AbortController()
  const run = calendarLoader({
    request: new Request('http://localhost/calendar', { signal: controller.signal }),
  } as LoaderFunctionArgs)
  // Rejection is asserted at the end; attach the handler now so the abort below
  // never lands on an unhandled promise.
  const settled = run.then(() => 'resolved', () => 'rejected')

  await waitFor(() => expect(attemptsFor('/calendar/events').length).toBe(1))
  const attempt = attemptsFor('/calendar/events')[0].signal
  expect(attempt).toBeDefined()
  expect(attempt!.aborted).toBe(false)

  controller.abort()

  // The signal handed to the in-flight attempt must follow the loader's, or the
  // request keeps running behind a navigation nobody is waiting for.
  await waitFor(() => expect(attempt!.aborted).toBe(true))
  // And the loop must actually end rather than retry the cancelled run.
  await expect(settled).resolves.toBe('rejected')
  expect(attemptsFor('/calendar/events').length).toBe(1)
})
