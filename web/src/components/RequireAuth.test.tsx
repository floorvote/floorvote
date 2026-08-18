import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const hoisted = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
}))

vi.mock('../hooks/useAuth', () => ({ useAuth: () => hoisted.auth }))

import { RequireAuth } from './RequireAuth'
import { createProgressBox } from '../lib/retryFetch'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

// jsdom's real location.reload is a no-op that logs "Not implemented:
// navigation to another Document" — it never throws, so a broken handler would
// go unnoticed. Swap in a spy so the click is actually asserted.
let reload: ReturnType<typeof vi.fn>
let originalLocation: PropertyDescriptor | undefined

beforeEach(() => {
  reload = vi.fn()
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  })
})
afterEach(() => {
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation)
})

describe('RequireAuth', () => {
  it('renders LoadingState (not bare text) while auth is loading', () => {
    hoisted.auth = { user: null, loading: true, authError: false, authProgress: createProgressBox() }
    render(<MemoryRouter><RequireAuth /></MemoryRouter>)
    advance(600)
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByRole('img', { name: 'Loading' })).toBeInTheDocument()
  })

  // The escalation is the loading branch's whole contract: a spinner that grows
  // a caption rather than a screen that never changes. Pinned here (not only in
  // LoadingState's own tests) because the authError branch below no longer
  // renders LoadingState at all, and nothing else would catch this branch being
  // swapped for a static splash.
  it('escalates the loading splash to "Taking longer than usual" at 10s', () => {
    hoisted.auth = { user: null, loading: true, authError: false, authProgress: createProgressBox() }
    render(<MemoryRouter><RequireAuth /></MemoryRouter>)
    advance(600)
    expect(screen.queryByText('Taking longer than usual…')).toBeNull()
    advance(10_000)
    expect(screen.getByText('Taking longer than usual…')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Loading' })).toBeInTheDocument()
  })

  // authError is only reachable for a *terminal* failure — retryFetch retries a
  // 5xx or a stall forever, so a 403/429/malformed body is what lands here. Its
  // progress box has already been cleared by then, which is why LoadingState is
  // the wrong thing to show: no retry copy, no button, just a spinner forever.
  describe('on a terminal authError', () => {
    beforeEach(() => {
      hoisted.auth = { user: null, loading: false, authError: true, authProgress: createProgressBox() }
    })

    it('explains what failed instead of spinning forever', () => {
      render(<MemoryRouter><RequireAuth /></MemoryRouter>)
      advance(600)
      expect(screen.getByText('We could not verify your session.')).toBeInTheDocument()
      // The regression this replaces: a bare LoadingState with a cleared
      // progress box, i.e. a spinner and nothing else.
      expect(screen.queryByRole('img', { name: 'Loading' })).toBeNull()
    })

    it('offers an enabled action that actually reloads', () => {
      render(<MemoryRouter><RequireAuth /></MemoryRouter>)
      advance(600)
      const button = screen.getByRole('button', { name: 'Try again' })
      expect(button).toBeEnabled()
      fireEvent.click(button)
      expect(reload).toHaveBeenCalledTimes(1)
    })

    // The escalation timer belongs to LoadingState; this branch has no spinner
    // to escalate, so waiting must not silently turn the card back into one.
    it('stays on the message rather than escalating into a spinner', () => {
      render(<MemoryRouter><RequireAuth /></MemoryRouter>)
      advance(11_000)
      expect(screen.getByText('We could not verify your session.')).toBeInTheDocument()
      expect(screen.queryByText('Taking longer than usual…')).toBeNull()
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    })
  })

  it('still redirects to login when there is no user and no error', () => {
    hoisted.auth = { user: null, loading: false, authError: false, authProgress: createProgressBox() }
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/" element={<RequireAuth />} />
        </Routes>
      </MemoryRouter>,
    )
    advance(600)
    expect(screen.queryByRole('img', { name: 'Loading' })).toBeNull()
    // Positive assertion, not just "no spinner": rendering nothing at all would
    // satisfy the negative one while silently dropping the redirect.
    expect(screen.getByText('login page')).toBeInTheDocument()
  })

  it('renders the routed children once a user is present', () => {
    hoisted.auth = { user: { id: 'u1' }, loading: false, authError: false, authProgress: createProgressBox() }
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/" element={<div>protected page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    advance(600)
    expect(screen.getByText('protected page')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Loading' })).toBeNull()
  })

  // The splash sits outside AppLayout, so the wordmark has to come from here —
  // `bare` would show a naked spinner on a blank page.
  it('uses the full-splash variant while loading', () => {
    hoisted.auth = { user: null, loading: true, authError: false, authProgress: createProgressBox() }
    render(<MemoryRouter><RequireAuth /></MemoryRouter>)
    advance(600)
    expect(screen.getByRole('img', { name: 'Loading' })).toHaveAttribute('width', '56')
  })

  describe('while a retry is pending', () => {
    it('surfaces the retry copy and a working "Retry now" while loading', () => {
      const progress = createProgressBox()
      progress.current = { attempt: 2, nextRetryAt: Date.now() + 3_000 }
      hoisted.auth = { user: null, loading: true, authError: false, authProgress: progress }
      render(<MemoryRouter><RequireAuth /></MemoryRouter>)
      advance(600)

      expect(screen.getByText("Can't reach the server.")).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
      expect(reload).toHaveBeenCalledTimes(1)
    })
  })
})
