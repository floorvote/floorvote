import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// The page is three cards, in this order: Profile, Appearance, Account. Notifications has its own page.

const auth = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))

function signIn(role: 'member' | 'admin' | 'owner') {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role, title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false,
  }
}

function mockConfig(modules: Record<string, unknown>) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => (path === '/config' ? { modules } : {}) as never)
}

const COLOR_BUTTON = /^(System|Light|Dark)$/

function cardOf(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).parentElement as HTMLElement
}

describe.each(['member', 'admin', 'owner'] as const)('Profile card regrouping, as a %s', (role) => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    Element.prototype.scrollIntoView = vi.fn()
    signIn(role)
    mockConfig({})
  })
  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('renders three cards headed Profile, Appearance, and Account, in that order', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['Profile', 'Appearance', 'Account'])
  })

  it('has no card called "Your Email"', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.queryByRole('heading', { name: 'Your Email' })).not.toBeInTheDocument()
  })

  it('has no notification switches', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.queryByText(/always get an email when someone mentions/i)).not.toBeInTheDocument()
  })

  it('puts the color mode control only in Appearance, once', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const groups = screen.getAllByRole('group', { name: 'Color mode' })
    expect(groups).toHaveLength(1)
    expect(cardOf('Appearance')).toContainElement(groups[0])
    for (const other of ['Profile', 'Account']) {
      expect(within(cardOf(other)).queryByRole('button', { name: COLOR_BUTTON }), other).not.toBeInTheDocument()
    }
    expect(screen.getAllByRole('button', { name: COLOR_BUTTON })).toHaveLength(3)
  })

  it('keeps the color mode setting id in the Appearance card, and has none of the email setting ids', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    for (const id of ['setting-email-replies', 'setting-email-digest', 'setting-week-ahead']) {
      expect(document.getElementById(id), id).toBeNull()
    }
    const colorMode = document.getElementById('setting-color-mode')
    expect(colorMode).not.toBeNull()
    expect(cardOf('Appearance')).toContainElement(colorMode as HTMLElement)
    expect(colorMode).toContainElement(screen.getByRole('group', { name: 'Color mode' }))
  })

  it('switches the color mode from the Appearance card', async () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const appearance = within(cardOf('Appearance'))
    await userEvent.setup().click(appearance.getByRole('button', { name: 'Dark' }))
    expect(localStorage.getItem('fv:color-mode')).toBe('dark')
    expect(appearance.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    expect(appearance.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false')
  })
})
