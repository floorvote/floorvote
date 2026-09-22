import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const auth = vi.hoisted(() => ({ user: null as unknown, loading: false }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: auth.user, loading: auth.loading }) }))
vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async () => ({ demoMode: false })),
  ApiError: class extends Error { constructor(public status: number, m: string) { super(m) } },
}))
vi.mock('../components/Turnstile', () => ({ Turnstile: () => null }))

import { Login } from './Login'

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>the app</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Login when someone is already signed in', () => {
  it('sends them into the app rather than showing a sign-in form', async () => {
    auth.user = { id: 'u1' }; auth.loading = false
    renderLogin()
    expect(await screen.findByText('the app')).toBeInTheDocument()
  })

  it('shows the form to a visitor who is not signed in', async () => {
    auth.user = null; auth.loading = false
    renderLogin()
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument()
    expect(screen.queryByText('the app')).toBeNull()
  })

  // Nothing is known until /auth/me answers, so redirecting on the first render
  // would bounce an anonymous visitor off the page they asked for.
  it('waits for auth to settle before deciding', () => {
    auth.user = null; auth.loading = true
    renderLogin()
    expect(screen.queryByText('the app')).toBeNull()
  })
})
