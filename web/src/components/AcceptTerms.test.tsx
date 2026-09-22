import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AcceptTerms } from './AcceptTerms'
import * as api from '../lib/api'

const navigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('../lib/legalVisibility', () => ({
  legalDocsVisible: () => ({ showTerms: true, showPrivacy: true }),
}))
vi.mock('../context/DemoContext', () => ({ useDemo: () => ({ demoMode: false }) }))

const setTermsAccepted = vi.fn()
const clearUser = vi.fn()
const authState = vi.hoisted(() => ({ kind: 'first_login' as 'first_login' | 'existing_member' | 'update' }))
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', termsAcceptanceKind: authState.kind },
    setTermsAccepted,
    clearUser,
  }),
}))

function renderIt(kind: 'first_login' | 'existing_member' | 'update' = 'first_login') {
  authState.kind = kind
  return render(<MemoryRouter><AcceptTerms /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(api, 'apiFetch').mockResolvedValue(undefined as never)
})

describe('AcceptTerms', () => {
  it('shows an unchecked checkbox', () => {
    renderIt()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  // Enabled on purpose: a disabled button gives no feedback on tap and
  // announces nothing about why it is inert.
  it('leaves Continue enabled while unchecked, and names the blocker when clicked', async () => {
    renderIt()
    const button = screen.getByRole('button', { name: /continue/i })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(await screen.findByText(/please confirm you agree to continue/i)).toBeInTheDocument()
    expect(api.apiFetch).not.toHaveBeenCalled()
  })

  it('posts once when checked, and clears the flag without a reload', async () => {
    renderIt()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledTimes(1))
    expect(api.apiFetch).toHaveBeenCalledWith('/auth/accept-terms', { method: 'POST' })
    await waitFor(() => expect(setTermsAccepted).toHaveBeenCalledTimes(1))
  })

  // A same-tab navigation would unmount the interstitial and discard the
  // checkbox — load-bearing, not cosmetic.
  it('opens every document link in a new tab', () => {
    renderIt()
    // Named twice now — in the body sentence and in the checkbox label — and
    // both have to open alongside, not navigate away.
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThanOrEqual(2)
    for (const link of links) expect(link).toHaveAttribute('target', '_blank')
    expect(links.some(l => /terms of use/i.test(l.textContent ?? ''))).toBe(true)
    expect(links.some(l => /privacy policy/i.test(l.textContent ?? ''))).toBe(true)
  })

  // The bare row of links under the body is gone: three sightings of the same
  // pair on one short screen read as boilerplate.
  it('names the documents twice, not three times', () => {
    renderIt()
    const mentions = (document.body.textContent ?? '').match(/Terms of Use/g) ?? []
    expect(mentions).toHaveLength(2)
  })

  it('welcomes a first_login by product name', () => {
    renderIt('first_login')
    expect(screen.getByRole('heading', { name: /welcome to floorvote/i })).toBeInTheDocument()
  })

  // Every existing member meets this screen on the initial rollout; greeting a
  // multi-year member as a newcomer would be wrong.
  it('says nothing welcoming to an existing_member', () => {
    renderIt('existing_member')
    expect(screen.queryByText(/welcome/i)).not.toBeInTheDocument()
    expect(screen.getByText(/before you continue/i)).toBeInTheDocument()
  })

  it('tells an update what changed underneath them', () => {
    renderIt('update')
    // textContent, not getByText: the sentence is broken up by the two links.
    expect(document.body.textContent).toMatch(/updated our Terms of Use and Privacy Policy since you last accepted/i)
  })

  it('signs out', async () => {
    renderIt()
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/auth/logout', { method: 'POST' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'))
    // Must forget the user locally too, or /login's authenticated redirect
    // bounces them straight back into the gated app.
    expect(clearUser).toHaveBeenCalled()
  })

  it('offers no way to decline — refusing is leaving', () => {
    renderIt()
    expect(screen.queryByRole('button', { name: /decline|reject|do not agree/i })).not.toBeInTheDocument()
  })
})

describe('AcceptTerms — onAccepted', () => {
  it('runs the hook after a successful acceptance, so a parked router can recover', async () => {
    const onAccepted = vi.fn()
    authState.kind = 'update'
    render(<MemoryRouter><AcceptTerms onAccepted={onAccepted} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(setTermsAccepted).toHaveBeenCalledTimes(1))
    expect(onAccepted).toHaveBeenCalledTimes(1)
  })

  it('does not run it when the box was never ticked', () => {
    const onAccepted = vi.fn()
    render(<MemoryRouter><AcceptTerms onAccepted={onAccepted} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(onAccepted).not.toHaveBeenCalled()
  })
})
