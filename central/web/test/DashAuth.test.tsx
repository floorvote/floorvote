import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Real Turnstile needs a browser iframe; mock with a button that drives onToken.
vi.mock('../src/components/Turnstile', () => ({
  Turnstile: ({ onToken }: { onToken: (t: string | null) => void }) => (
    <button type="button" data-testid="solve" onClick={() => onToken('tok-123')}>solve</button>
  ),
}))

import Login from '../src/pages/Login'
import DashVerify from '../src/pages/DashVerify'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data, meta: {} }), { status })
}

// jsdom's window.location.replace is non-configurable and can't be spied directly;
// replace the whole location object with a writable mock (mirrors auth.test.tsx).
function stubLocationReplace() {
  const replace = vi.fn()
  Object.defineProperty(window, 'location', {
    value: { ...window.location, replace },
    writable: true,
    configurable: true,
  })
  return replace
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('Dashboard Login — config-driven Turnstile sitekey', () => {
  it('renders the widget and gates submit when a sitekey is served', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ turnstileSiteKey: '0xTEST' }))
    render(<MemoryRouter><Login /></MemoryRouter>)
    await screen.findByTestId('solve')
    const btn = screen.getByRole('button', { name: /send sign-in link/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('solve'))
    await waitFor(() => expect((screen.getByRole('button', { name: /send sign-in link/i }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('renders no widget and enables submit when no sitekey is served (fail-open)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ turnstileSiteKey: '' }))
    render(<MemoryRouter><Login /></MemoryRouter>)
    await waitFor(() => expect((screen.getByRole('button', { name: /send sign-in link/i }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByTestId('solve')).toBeNull()
  })
})

describe('DashVerify — two-step interstitial', () => {
  it('POSTs the token to the callback on click and navigates home on success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }))
    const replaceSpy = stubLocationReplace()
    render(<MemoryRouter initialEntries={['/auth/verify?token=abc123']}><DashVerify /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find((c) => String(c[0]) === '/admin/dash/auth/callback')
      expect(call).toBeTruthy()
      expect(String((call![1] as RequestInit).method)).toBe('POST')
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ token: 'abc123' })
    })
    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith('/'))
  })

  it('shows an error and does not navigate when the token is invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: { code: 'unauthorized', message: 'Token already used' } }, 401))
    const replaceSpy = stubLocationReplace()
    render(<MemoryRouter initialEntries={['/auth/verify?token=bad']}><DashVerify /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(screen.getByText(/back to sign in/i)).toBeInTheDocument())
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('shows a missing-token message when no token is present', () => {
    render(<MemoryRouter initialEntries={['/auth/verify']}><DashVerify /></MemoryRouter>)
    expect(screen.getByText(/missing sign-in token/i)).toBeInTheDocument()
  })
})
