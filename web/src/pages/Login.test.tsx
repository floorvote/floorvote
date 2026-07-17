import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...a: unknown[]) => fetchMock(...a) }))

// The real Turnstile widget needs a browser iframe; mock it with a button that
// drives onToken so we can simulate solving / not-solving deterministically.
vi.mock('../components/Turnstile', () => ({
  Turnstile: ({ onToken }: { onToken: (t: string | null) => void }) => (
    <button type="button" data-testid="solve" onClick={() => onToken('tok-123')}>solve</button>
  ),
}))

vi.mock('../lib/legalDocs', () => ({ hasTerms: true, hasPrivacy: true }))

import { Login } from './Login'

// Default bootstrap: Turnstile configured (sitekey present), not demo.
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ demoMode: false, turnstileSiteKey: '0xTEST' }) // mount calls /auth/demo-mode
})

function renderLogin() {
  return render(<MemoryRouter><Login /></MemoryRouter>)
}

describe('Login — Turnstile gating', () => {
  it('disables "Send sign-in link" until the widget produces a token', async () => {
    renderLogin()
    // Wait for the bootstrap fetch (sitekey) to resolve and render the widget.
    await screen.findByTestId('solve')
    const btn = screen.getByRole('button', { name: /send sign-in link/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('solve'))
    await waitFor(() => expect((screen.getByRole('button', { name: /send sign-in link/i }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('includes the turnstileToken in the magic-link request', async () => {
    renderLogin()
    await screen.findByTestId('solve')
    fireEvent.click(screen.getByTestId('solve'))
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'a@b.org' } })
    fireEvent.click(screen.getByRole('button', { name: /send sign-in link/i }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/auth/magic-link')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as { body: string }).body)).toEqual({ email: 'a@b.org', turnstileToken: 'tok-123' })
    })
  })

  it('re-gates submit (clears the token) when the request fails', async () => {
    renderLogin()
    await screen.findByTestId('solve')
    fireEvent.click(screen.getByTestId('solve'))
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'a@b.org' } })
    fetchMock.mockRejectedValueOnce(new Error('boom')) // the magic-link POST fails
    fireEvent.click(screen.getByRole('button', { name: /send sign-in link/i }))
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /send sign-in link/i }) as HTMLButtonElement
      expect(btn.disabled).toBe(true) // token cleared, widget remounted → must re-solve
    })
  })
})

describe('Login — Turnstile not configured (fail-open, self-host default)', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue({ demoMode: false, turnstileSiteKey: '' }) // no sitekey served
  })

  it('renders no widget and enables submit without a token', async () => {
    renderLogin()
    // Submit enables once the bootstrap fetch resolves (no token required).
    await waitFor(() => expect((screen.getByRole('button', { name: /send sign-in link/i }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByTestId('solve')).toBeNull() // no widget rendered
  })

  it('does not fire a second magic-link request while one is in flight', async () => {
    // Bootstrap resolves (no sitekey → submit enabled); the magic-link POST hangs
    // so the request stays in flight while we click again.
    fetchMock.mockImplementation((path: string) =>
      path === '/auth/magic-link'
        ? new Promise(() => {})
        : Promise.resolve({ demoMode: false, turnstileSiteKey: '' }))
    renderLogin()
    const btn = await screen.findByRole('button', { name: /send sign-in link/i })
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'a@b.org' } })
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => {
      const magicCalls = fetchMock.mock.calls.filter((c) => c[0] === '/auth/magic-link')
      expect(magicCalls.length).toBe(1)
    })
  })

  it('sends a null turnstileToken when Turnstile is not configured', async () => {
    renderLogin()
    await waitFor(() => expect((screen.getByRole('button', { name: /send sign-in link/i }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'a@b.org' } })
    fireEvent.click(screen.getByRole('button', { name: /send sign-in link/i }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/auth/magic-link')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as { body: string }).body)).toEqual({ email: 'a@b.org', turnstileToken: null })
    })
  })
})

describe('Login — legal links', () => {
  it('links to Terms of Use and Privacy Policy when the docs exist', async () => {
    renderLogin()
    expect(await screen.findByRole('link', { name: 'Terms of Use' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy')
  })
})
