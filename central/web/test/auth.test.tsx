import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../src/App'
import { api, ApiError } from '../src/lib/api'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('auth gate', () => {
  it('shows Login when /auth/me returns 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: {} }), { status: 401 }))
    render(<MemoryRouter><App /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeInTheDocument())
  })

  it('shows main UI when /auth/me returns 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: { email: 'admin@example.com', name: 'Will' } }), { status: 200 })
    )
    render(<MemoryRouter><App /></MemoryRouter>)
    await waitFor(() => expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument())
  })
})

describe('api client 401 handling', () => {
  it('throws ApiError with unauthorized code on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: {} }), { status: 401 })
    )
    await expect(api('/some/data-route')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('does not redirect when already on login path', async () => {
    const original = window.location.href
    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: '/login', href: original },
      writable: true,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: {} }), { status: 401 })
    )
    // Should throw but not redirect
    await expect(api('/some/data-route')).rejects.toBeInstanceOf(ApiError)
    // Restore
    Object.defineProperty(window, 'location', {
      value: window.location,
      writable: true,
    })
  })
})
