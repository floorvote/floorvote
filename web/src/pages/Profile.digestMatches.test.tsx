import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// #366: "Include newly matched bills" sits under the digest switch, for
// non-admins only, on by default.

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

function signIn(role: 'member' | 'admin' | 'owner', over: Record<string, unknown> = {}) {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role, title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

const matchesName = /include newly matched bills/i

describe('Profile: the digest new-match option', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => (path === '/config' ? { modules: { 'email-digest': { enabled: true } } } : {}) as never)
  })

  it('shows a member the option, on, nested inside the digest row', () => {
    signIn('member')
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const option = screen.getByRole('switch', { name: matchesName })
    expect(option).toBeChecked()
    expect(document.getElementById('setting-email-digest')).toContainElement(option)
  })

  it.each(['admin', 'owner'] as const)('shows no option to an %s, who always gets the section', (role) => {
    signIn(role)
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.queryByRole('switch', { name: matchesName })).not.toBeInTheDocument()
  })

  it("reflects a member's saved choice", () => {
    signIn('member', { emailDigestMatchesEnabled: false })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getByRole('switch', { name: matchesName })).not.toBeChecked()
  })

  it("saves the member's choice", async () => {
    signIn('member')
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const option = screen.getByRole('switch', { name: matchesName })

    await userEvent.click(option)

    expect(api.apiFetch).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ emailDigestMatchesEnabled: false }) })
    expect(option).not.toBeChecked()
  })

  it('is unavailable while the digest switch is off', () => {
    signIn('member', { emailDigestEnabled: false })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const option = screen.getByRole('switch', { name: matchesName })
    expect(option).toBeDisabled()
    expect(within(document.getElementById('setting-email-digest') as HTMLElement).getByRole('switch', { name: /recent bill activity/i })).not.toBeChecked()
  })
})

// #587: the switch's visible sentence says what it does, from the instance
// cadence, and is the switch's accessible name (WCAG 2.5.3, label in name).

const DAILY = 'Also include newly matched bills in the digest, and send the digest on days with only those.'
const WEEKLY = 'Also include newly matched bills in the digest, and send the digest on weeks with only those.'

function mockModules(settings: Record<string, string> | undefined) {
  const digest = settings === undefined ? { enabled: true } : { enabled: true, settings }
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => (path === '/config' ? { modules: { 'email-digest': digest } } : {}) as never)
}

function renderedSwitch() {
  render(<MemoryRouter><Profile /></MemoryRouter>)
  return screen.getByRole('switch', { name: matchesName })
}

describe('Profile: the digest new-match option wording', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    signIn('member')
  })

  it('shows the daily sentence, exactly, for a daily digest', async () => {
    mockModules({ frequency: 'daily' })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByText(DAILY)).toBeInTheDocument()
    expect(screen.queryByText(WEEKLY)).not.toBeInTheDocument()
  })

  it('shows the weekly sentence, exactly, for a weekly digest', async () => {
    mockModules({ frequency: 'weekly', weeklyDay: '3' })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByText(WEEKLY)).toBeInTheDocument()
    expect(screen.queryByText(DAILY)).not.toBeInTheDocument()
  })

  it.each([
    ['no frequency setting', { weeklyDay: '3' }],
    ['no settings at all', undefined],
    ['an unknown frequency', { frequency: 'hourly' }],
    ['an empty frequency', { frequency: '' }],
  ])('falls back to the daily default with %s, as the digest description does', async (_label, settings) => {
    mockModules(settings)
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/config'))
    expect(await screen.findByText(DAILY)).toBeInTheDocument()
    expect(screen.queryByText(WEEKLY)).not.toBeInTheDocument()
  })

  it('sets the option in regular weight, unlike the bold setting titles', async () => {
    mockModules({ frequency: 'weekly', weeklyDay: '3' })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const label = await screen.findByText(WEEKLY)
    expect(label.style.fontWeight).toBe('')
    expect(screen.getByText('Email digest of recent bill activity').style.fontWeight).not.toBe('')
  })

  it('shows the daily sentence before the config has loaded', () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(() => new Promise(() => {}) as never)
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getByText(DAILY)).toBeInTheDocument()
  })

  it('shows the daily sentence when the config fails to load', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/config') throw new Error('offline')
      return {} as never
    })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/config'))
    expect(screen.getByText(DAILY)).toBeInTheDocument()
  })

  it('names the switch with the visible daily sentence, through aria-labelledby alone', async () => {
    mockModules({ frequency: 'daily' })
    const option = renderedSwitch()
    await screen.findByText(DAILY)
    expect(option).toHaveAccessibleName(DAILY)
    expect(option).not.toHaveAttribute('aria-label')
    const labelId = option.getAttribute('aria-labelledby') as string
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId)).toHaveTextContent(DAILY)
    expect(screen.getByText(DAILY)).toBe(document.getElementById(labelId))
  })

  it('names the switch with the visible weekly sentence, through aria-labelledby alone', async () => {
    mockModules({ frequency: 'weekly' })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WEEKLY)
    const option = screen.getByRole('switch', { name: matchesName })
    expect(option).toHaveAccessibleName(WEEKLY)
    expect(option).not.toHaveAttribute('aria-label')
    const labelId = option.getAttribute('aria-labelledby') as string
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId)).toHaveTextContent(WEEKLY)
    expect(screen.getByText(WEEKLY)).toBe(document.getElementById(labelId))
  })

  it('keeps the accessible name equal to the visible sentence when the cadence changes the sentence', async () => {
    mockModules({ frequency: 'weekly' })
    const option = renderedSwitch()
    await screen.findByText(WEEKLY)
    expect(option).toHaveAccessibleName(screen.getByText(WEEKLY).textContent as string)
    expect(option).not.toHaveAccessibleName(DAILY)
  })

  it('no longer shows the old title or description', async () => {
    mockModules({ frequency: 'daily' })
    renderedSwitch()
    await screen.findByText(DAILY)
    expect(screen.queryByText('Include newly matched bills')).not.toBeInTheDocument()
    expect(screen.queryByText(/your keywords/i)).not.toBeInTheDocument()
  })

  it('keeps the switch nested under the digest, inside the Notifications card', async () => {
    mockModules({ frequency: 'weekly' })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WEEKLY)
    const option = screen.getByRole('switch', { name: matchesName })
    const digestRow = document.getElementById('setting-email-digest') as HTMLElement
    expect(digestRow).toContainElement(option)
    const card = screen.getByRole('heading', { name: 'Notifications' }).parentElement as HTMLElement
    expect(card).toContainElement(option)
    expect(card).toContainElement(digestRow)
  })

  it.each(['admin', 'owner'] as const)('shows an %s neither the switch nor the sentence', async (role) => {
    signIn(role)
    mockModules({ frequency: 'weekly' })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/config'))
    expect(screen.queryByRole('switch', { name: matchesName })).not.toBeInTheDocument()
    expect(screen.queryByText(WEEKLY)).not.toBeInTheDocument()
    expect(screen.queryByText(DAILY)).not.toBeInTheDocument()
  })

  it('still saves a toggle on a weekly digest', async () => {
    mockModules({ frequency: 'weekly' })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WEEKLY)
    const option = screen.getByRole('switch', { name: WEEKLY })
    expect(option).toBeChecked()

    await userEvent.click(option)

    expect(api.apiFetch).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ emailDigestMatchesEnabled: false }) })
    expect(option).not.toBeChecked()
  })
})
