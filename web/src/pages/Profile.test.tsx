import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'a@b.c', name: 'A', role: 'member', title: null,
      canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true, lastSeenFeed: null,
      isLastOwner: false,
    },
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))

function mockConfig(modules: Record<string, unknown>) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') return { modules } as never
    return {} as never
  })
}

describe('Profile heading structure', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('exposes exactly one top-level heading, for the Profile section', () => {
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Profile')
  })

  it('exposes the Appearance and Account section titles as level-2 headings, and no Notifications card', () => {
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.queryByRole('heading', { name: 'Notifications' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Account' })).toBeInTheDocument()
  })
})

describe('Profile title field', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('labels the line under a member\'s name "Title"', () => {
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getByLabelText('Title')).toBeInTheDocument()
  })
})

describe('Profile Appearance control', () => {
  const isDark = () => document.documentElement.classList.contains('dark')
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  function appearance() {
    return within(screen.getByRole('group', { name: 'Color mode' }))
  }

  it('offers System, Light, and Dark, with System chosen by default', () => {
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const g = appearance()
    expect(g.getAllByRole('button').map(b => b.textContent)).toEqual(['System', 'Light', 'Dark'])
    expect(g.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true')
    expect(g.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'false')
    expect(g.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('applies and stores Dark, and shows it chosen after a reload', async () => {
    const user = userEvent.setup()
    mockConfig({})
    const { unmount } = render(<MemoryRouter><Profile /></MemoryRouter>)
    await user.click(appearance().getByRole('button', { name: 'Dark' }))
    expect(isDark()).toBe(true)
    expect(localStorage.getItem('fv:color-mode')).toBe('dark')
    expect(appearance().getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    expect(appearance().getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false')

    unmount()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(appearance().getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('applies and stores Light', async () => {
    const user = userEvent.setup()
    localStorage.setItem('fv:color-mode', 'dark')
    document.documentElement.classList.add('dark')
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(appearance().getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(appearance().getByRole('button', { name: 'Light' }))
    expect(isDark()).toBe(false)
    expect(localStorage.getItem('fv:color-mode')).toBe('light')
    expect(appearance().getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('goes back to System by clearing the stored choice', async () => {
    const user = userEvent.setup()
    localStorage.setItem('fv:color-mode', 'light')
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await user.click(appearance().getByRole('button', { name: 'System' }))
    expect(localStorage.getItem('fv:color-mode')).toBeNull()
    expect(appearance().getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true')
  })
})
