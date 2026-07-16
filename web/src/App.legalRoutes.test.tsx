import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// Control which docs are "bundled" so both the present and absent branches
// of the conditional routes are exercised.
vi.mock('./lib/legalDocs', () => ({
  legalDocs: { terms: '# Terms of Use\n\nHello.', privacy: null },
  hasTerms: true,
  hasPrivacy: false,
}))

// Loader-backed authed routes call apiFetch; an unauthenticated 401 must route
// to login, not the error boundary (mirrors App.authRedirect.test.tsx).
vi.mock('./lib/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'ApiError'
    }
  }
  return { ApiError, apiFetch: async () => { throw new ApiError(401, 'Not authenticated') } }
})

import { routes } from './App'
import { AuthProvider } from './context/AuthContext'

describe('legal routes', () => {
  it('renders /terms when the terms doc is bundled', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/terms'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
    expect(await screen.findByRole('heading', { name: 'Terms of Use' })).toBeInTheDocument()
  })

  it('sends /privacy to login when the privacy doc is absent', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/privacy'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument()
  })
})
