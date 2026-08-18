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

describe('RequireAuth', () => {
  it('renders LoadingState (not bare text) while auth is loading', () => {
    hoisted.auth = { user: null, loading: true, authError: false, authProgress: createProgressBox() }
    render(<MemoryRouter><RequireAuth /></MemoryRouter>)
    advance(600)
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByRole('img', { name: 'Loading' })).toBeInTheDocument()
  })

  it('replaces the "Unable to connect" dead end on authError', () => {
    hoisted.auth = { user: null, loading: false, authError: true, authProgress: createProgressBox() }
    render(<MemoryRouter><RequireAuth /></MemoryRouter>)
    advance(600)
    expect(screen.queryByText(/unable to connect/i)).toBeNull()
    expect(screen.getByRole('img', { name: 'Loading' })).toBeInTheDocument()
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
    // jsdom's real location.reload is a no-op that logs "Not implemented:
    // navigation to another Document" — it never throws, so a broken handler
    // would go unnoticed. Swap in a spy so the click is actually asserted.
    let reload: ReturnType<typeof vi.fn>
    let original: PropertyDescriptor | undefined

    beforeEach(() => {
      reload = vi.fn()
      original = Object.getOwnPropertyDescriptor(window, 'location')
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload },
      })
    })
    afterEach(() => {
      if (original) Object.defineProperty(window, 'location', original)
    })

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
