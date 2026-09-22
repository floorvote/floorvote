import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as api from '../lib/api'
import { ApiError } from '../lib/api'

const auth = vi.hoisted(() => ({ user: null as unknown, loading: false }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: auth.user, loading: auth.loading }) }))

import { AuthVerify } from './AuthVerify'

let replace: ReturnType<typeof vi.fn>
let originalLocation: PropertyDescriptor | undefined

beforeEach(() => {
  auth.user = null; auth.loading = false
  replace = vi.fn()
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', {
    configurable: true, value: { ...window.location, replace },
  })
})
afterEach(() => {
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation)
  vi.restoreAllMocks()
})

/** Route apiFetch by path: status GETs answer from `status`, the POST resolves. */
function server(status: { status: string; email?: string } | Error) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path.startsWith('/auth/verify/status')) {
      if (status instanceof Error) throw status
      return status as never
    }
    return undefined as never
  })
}

const renderVerify = () =>
  render(<MemoryRouter initialEntries={['/auth/verify?token=abc']}><AuthVerify /></MemoryRouter>)

const posts = (spy: ReturnType<typeof server>) =>
  spy.mock.calls.filter(c => c[0] === '/auth/verify').length

describe('AuthVerify status branching', () => {
  it('signed out: shows the button and does not act on the status', async () => {
    const spy = server({ status: 'valid', email: 'owner@example.com' })
    renderVerify()
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
    expect(posts(spy)).toBe(0)
  })

  it('signed in + spent link: into the app, with no POST', async () => {
    auth.user = { id: 'u1', email: 'a@example.com' }
    const spy = server({ status: 'used' })
    renderVerify()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(posts(spy)).toBe(0)
  })

  it('signed in + expired link: same', async () => {
    auth.user = { id: 'u1', email: 'a@example.com' }
    const spy = server({ status: 'expired' })
    renderVerify()
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(posts(spy)).toBe(0)
  })

  // Consumed, not skipped: an unspent link left in a mailbox stays usable by
  // whoever reads that mailbox next.
  it('signed in + valid link for the same account: consumes it silently', async () => {
    auth.user = { id: 'u1', email: 'a@example.com' }
    const spy = server({ status: 'valid', email: 'a@example.com' })
    renderVerify()
    await waitFor(() => expect(posts(spy)).toBe(1))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(screen.queryByText(/signed in as/i)).toBeNull()
  })

  it('matches the account case-insensitively', async () => {
    auth.user = { id: 'u1', email: 'A@Example.com' }
    const spy = server({ status: 'valid', email: 'a@example.com' })
    renderVerify()
    await waitFor(() => expect(posts(spy)).toBe(1))
    expect(screen.queryByText(/signed in as/i)).toBeNull()
  })

  it('signed in + valid link for someone else: asks, naming both addresses', async () => {
    auth.user = { id: 'u1', email: 'a@example.com' }
    const spy = server({ status: 'valid', email: 'b@example.com' })
    renderVerify()
    // Both appear more than once by design -- heading, body, and buttons -- so
    // count rather than expecting a single node.
    expect((await screen.findAllByText(/a@example\.com/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/b@example\.com/).length).toBeGreaterThan(0)
    // The signed-in account is named, never rendered as "you".
    expect(screen.getByRole('heading')).toHaveTextContent('You are signed in as a@example.com')
    expect(posts(spy)).toBe(0)
    expect(replace).not.toHaveBeenCalled()
  })

  it('continues as the other account only on request', async () => {
    auth.user = { id: 'u1', email: 'a@example.com' }
    const spy = server({ status: 'valid', email: 'b@example.com' })
    renderVerify()
    fireEvent.click(await screen.findByRole('button', { name: /continue as b@example\.com/i }))
    await waitFor(() => expect(posts(spy)).toBe(1))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
  })

  it('staying signed in leaves the token alone', async () => {
    auth.user = { id: 'u1', email: 'a@example.com' }
    const spy = server({ status: 'valid', email: 'b@example.com' })
    renderVerify()
    fireEvent.click(await screen.findByRole('button', { name: /stay signed in/i }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
    expect(posts(spy)).toBe(0)
  })

  // The endpoint is an optimisation over a flow that already works. It must
  // never be the reason someone cannot sign in.
  it('falls back to the button when the status call fails', async () => {
    auth.user = { id: 'u1', email: 'a@example.com' }
    server(new ApiError(500, 'boom'))
    renderVerify()
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it('waits for auth to settle before deciding', async () => {
    auth.user = null; auth.loading = true
    server({ status: 'used' })
    renderVerify()
    await new Promise(r => setTimeout(r, 50))
    expect(replace).not.toHaveBeenCalled()
  })
})
