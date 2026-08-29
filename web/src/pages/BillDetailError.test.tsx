import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

const { routeError } = vi.hoisted(() => ({ routeError: { current: null as unknown } }))
vi.mock('react-router-dom', () => ({
  useRouteError: () => routeError.current,
  isRouteErrorResponse: (e: unknown) => e instanceof Response,
  Link: ({ children }: { children: React.ReactNode }) => React.createElement('a', null, children),
}))

import { BillDetailError } from './BillDetailError'

function renderFor(status: number) {
  routeError.current = new Response('', { status })
  render(<BillDetailError />)
}

describe('BillDetailError', () => {
  // SPA not-found handling routes every unmatched path into the bill route,
  // whose three segments match almost anything — so most readers who land on
  // the 404 never asked for a bill. Saying a bill failed to load sends them
  // looking for a bill that was never involved.
  it('renders a not-found page for a 404, without claiming a bill broke', () => {
    renderFor(404)
    expect(screen.getByText(/page not found/i)).toBeInTheDocument()
    expect(screen.queryByText(/failed to load bill/i)).not.toBeInTheDocument()
  })

  it('keeps the ambiguous-bill guidance on a 409', () => {
    renderFor(409)
    expect(screen.getByText(/exists in multiple states/i)).toBeInTheDocument()
  })

  it('still reports a genuine failure on a 500', () => {
    renderFor(500)
    expect(screen.getByText(/failed to load bill/i)).toBeInTheDocument()
  })
})
