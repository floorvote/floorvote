import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as api from '../lib/api'
import { ApiError } from '../lib/api'

const auth = vi.hoisted(() => ({ user: null as unknown }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: auth.user }) }))

import { AuthVerify } from './AuthVerify'

// A signed-in person clicking a spent link is the common case, not an edge one:
// every visit extends the session, so a regular user never lapses, and old
// invite emails sit in inboxes for months. Before this they were told the link
// was used and asked to request another they did not need -- and the only way
// back into the app was knowing to type the bare domain.
let replace: ReturnType<typeof vi.fn>
let originalLocation: PropertyDescriptor | undefined

beforeEach(() => {
  replace = vi.fn()
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, replace, search: '?token=abc' },
  })
})
afterEach(() => {
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation)
  vi.restoreAllMocks()
})

function renderVerify() {
  return render(
    <MemoryRouter initialEntries={['/auth/verify?token=abc']}><AuthVerify /></MemoryRouter>,
  )
}

describe('AuthVerify with a spent link', () => {
  it('sends an already signed-in visitor into the app instead of a dead end', async () => {
    auth.user = { id: 'u1' }
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new ApiError(400, 'used'))
    renderVerify()
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(screen.queryByText(/already been used/i)).toBeNull()
  })

  it('does the same for an expired link', async () => {
    auth.user = { id: 'u1' }
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new ApiError(400, 'expired'))
    renderVerify()
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
  })

  it('still explains itself to a visitor who is NOT signed in', async () => {
    auth.user = null
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new ApiError(400, 'used'))
    renderVerify()
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/already been used/i)).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  // A valid token must still be consumed for a signed-in visitor: that is how a
  // forwarded link signs you in as the person it was addressed to.
  it('still consumes a VALID link even when someone is already signed in', async () => {
    auth.user = { id: 'u1' }
    const fetchSpy = vi.spyOn(api, 'apiFetch').mockResolvedValue(undefined as never)
    renderVerify()
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/auth/verify', expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
  })

  it('shows an invalid link as invalid, signed in or not', async () => {
    auth.user = { id: 'u1' }
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new ApiError(400, 'invalid'))
    renderVerify()
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/link is invalid/i)).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})
