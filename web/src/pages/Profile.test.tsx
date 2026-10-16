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

describe('Profile notification settings', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('greys + notes the digest row when the admin has digest off, preserving the member toggle', async () => {
    mockConfig({ 'email-digest': { enabled: false }, 'week-ahead': { enabled: true } })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByText('Turned off by your coalition.')).toBeInTheDocument()
    const digestSwitch = screen.getByRole('switch', { name: /recent bill activity/i })
    expect(digestSwitch).toBeDisabled()
    expect(digestSwitch).toBeChecked() // member's stored preference is preserved
    const weekAheadSwitch = screen.getByRole('switch', { name: /upcoming hearings and events/i })
    expect(weekAheadSwitch).not.toBeDisabled()
  })

  it('greys + notes the week-ahead row when the admin has week-ahead off', async () => {
    mockConfig({ 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay: '1' } }, 'week-ahead': { enabled: false } })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByText('Turned off by your coalition.')).toBeInTheDocument()
    const weekAheadSwitch = screen.getByRole('switch', { name: /upcoming hearings and events/i })
    expect(weekAheadSwitch).toBeDisabled()
    const digestSwitch = screen.getByRole('switch', { name: /recent bill activity/i })
    expect(digestSwitch).not.toBeDisabled()
  })

  it('shows no "turned off" note when both features are enabled', async () => {
    mockConfig({ 'email-digest': { enabled: true, settings: { frequency: 'daily' } }, 'week-ahead': { enabled: true } })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText('Email digest of recent bill activity')
    expect(screen.queryByText('Turned off by your coalition.')).not.toBeInTheDocument()
  })
})

describe('Profile heading structure', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('exposes exactly one top-level heading, for the Profile section', () => {
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Profile')
  })

  it('exposes the Your Email and Account section titles as level-2 headings', () => {
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getByRole('heading', { level: 2, name: 'Your Email' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Account' })).toBeInTheDocument()
  })
})

describe('Profile "Your Email" section', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('holds the replies, digest, and week-ahead switches and states that mention emails are always sent', async () => {
    mockConfig({ 'email-digest': { enabled: true }, 'week-ahead': { enabled: true } })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const heading = screen.getByRole('heading', { level: 2, name: 'Your Email' })
    const section = heading.parentElement as HTMLElement
    const replies = within(section).getByRole('switch', { name: /replies on bills you've commented on/i })
    expect(replies).toBeChecked()
    expect(within(section).getByRole('switch', { name: /recent bill activity/i })).toBeInTheDocument()
    expect(within(section).getByRole('switch', { name: /upcoming hearings and events/i })).toBeInTheDocument()
    expect(within(section).getByText("You'll always get an email when someone mentions you, your role, @admins, or @everyone.")).toBeInTheDocument()
    expect(within(section).queryByRole('switch', { name: /mention/i })).not.toBeInTheDocument()
  })

  it.each([
    ['setting-email-replies', /replies on bills you've commented on/i],
    ['setting-email-digest', /recent bill activity/i],
    ['setting-week-ahead', /upcoming hearings and events/i],
  ])('email-footer deep link #%s lands on and highlights its switch', async (id, name) => {
    mockConfig({ 'email-digest': { enabled: true }, 'week-ahead': { enabled: true } })
    render(<MemoryRouter initialEntries={[`/profile#${id}`]}><Profile /></MemoryRouter>)
    const row = document.getElementById(id) as HTMLElement
    expect(row).toContainElement(screen.getByRole('switch', { name }))
    await vi.waitFor(() => expect(row.style.boxShadow).not.toBe(''))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})

describe('Profile reply-emails switch', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('saves the member\'s choice', async () => {
    const fetch = vi.spyOn(api, 'apiFetch').mockImplementation(async () => ({}) as never)
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const replies = screen.getByRole('switch', { name: /replies on bills you've commented on/i })

    await userEvent.click(replies)

    expect(fetch).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ emailRepliesEnabled: false }) })
    expect(replies).not.toBeChecked()
  })
})

describe('Profile title field', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('labels the line under a member\'s name "Title", never "Subtitle"', () => {
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getByLabelText('Title')).toBeInTheDocument()
    expect(screen.queryByText(/subtitle/i)).not.toBeInTheDocument()
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
    return within(screen.getByRole('group', { name: 'Appearance' }))
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
