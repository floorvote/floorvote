import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// Every route loader (feed/bills/calendar/bill-detail) runs unconditionally on
// navigation under the RR7 data router, regardless of whether RequireAuth's
// render-time guard will end up redirecting. An unauthenticated visit must not
// let the resulting 401 bubble into the router's default error boundary.
vi.mock('./lib/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'ApiError'
    }
  }
  return {
    ApiError,
    apiFetch: async () => { throw new ApiError(401, 'Not authenticated') },
  }
})

import { routes } from './App'
import { AuthProvider } from './context/AuthContext'

describe('unauthenticated visit to a loader-backed route', () => {
  it('renders the login page instead of the router error boundary', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)

    expect(await screen.findByText(/sign in/i)).toBeInTheDocument()
    expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument()
  })

  it('redirects from the calendar route too', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/calendar'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)

    expect(await screen.findByText(/sign in/i)).toBeInTheDocument()
  })
})
