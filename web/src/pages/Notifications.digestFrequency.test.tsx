import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
import * as api from '../lib/api'

// How often the email digest comes is each person's choice: every morning, or once a week on a weekday they pick. The
// menu sits on the right of "Email digest" in "Your notifications". "For your whole coalition" has no say in it.

const auth = vi.hoisted(() => ({ user: {} as Record<string, unknown>, setEmailDigestWeeklyDay: vi.fn() }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailDigestWeeklyDay: auth.setEmailDigestWeeklyDay, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))

const FRIDAY = { 'email-digest': { enabled: true }, 'week-ahead': { enabled: true, settings: { weeklyDay: '5' } } }

function signIn(role: 'member' | 'admin', over: Record<string, unknown> = {}) {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role, title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

function mock(modules: Record<string, unknown> = FRIDAY) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') return { modules, mentionEmailsEnabled: true } as never
    if (path === '/views') return { views: [] } as never
    if (path === '/roles') return [] as never
    return {} as never
  })
}

const section = async (name: string) =>
  within((await screen.findByRole('heading', { level: 2, name })).parentElement as HTMLElement)
const patches = () => vi.mocked(api.apiFetch).mock.calls
  .filter(([p, o]) => p === '/users/me' && (o as { method?: string } | undefined)?.method === 'PATCH')
  .map(([, o]) => JSON.parse((o as { body: string }).body) as Record<string, unknown>)

beforeEach(() => {
  vi.restoreAllMocks()
  auth.setEmailDigestWeeklyDay.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
  signIn('member')
  mock()
})

// The menu is the app's own dropdown (ScopeSelect): a button named "How often: <choice>" that opens a list of choices
// below it, rather than the browser's select, which opens over the button.
const button = async () => (await section('Your notifications')).findByRole('button', { name: /^How often: / })
const choose = async (label: string) => {
  await userEvent.click(await button())
  // A row takes the click; its radio is drawn by the row and takes none itself.
  await userEvent.click(within(screen.getByRole('radiogroup', { name: 'How often' })).getByText(label))
}

describe("a person's digest schedule", () => {
  it('offers every morning or any weekday, at every morning for a person who has not chosen', async () => {
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    const menu = await button()
    expect(menu).toHaveAccessibleName('How often: Every morning')
    expect(menu).toHaveTextContent('Every morning')
    await userEvent.click(menu)
    const list = screen.getByRole('radiogroup', { name: 'How often' })
    expect(within(list).getAllByRole('radio').map(r => r.closest('label')?.textContent)).toEqual([
      'Every morning', 'Every Monday morning', 'Every Tuesday morning', 'Every Wednesday morning',
      'Every Thursday morning', 'Every Friday morning', 'Every Saturday morning', 'Every Sunday morning',
    ])
    expect(within(list).getByRole('radio', { name: 'Every morning' })).toBeChecked()
    expect(await screen.findByText('One email that sums up what changed on your bills since the last one. Sent only when something changed.')).toBeInTheDocument()
  })

  it('opens its list below the button, not over it', async () => {
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    await userEvent.click(await button())
    expect(screen.getByRole('radiogroup', { name: 'How often' }).style.top).toBe('calc(100% + 4px)')
  })

  it('shares a row with the Email digest heading, with the definition below across the whole card', async () => {
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    const yours = await section('Your notifications')
    const row = yours.getByRole('heading', { level: 3, name: 'Email digest' }).parentElement as HTMLElement
    expect(row).toContainElement(await button())
    expect(row.style.alignItems).toBe('center')
    const definition = await yours.findByText('One email that sums up what changed on your bills since the last one. Sent only when something changed.')
    expect(row).not.toContainElement(definition)
    expect(definition.parentElement).toBe(row.parentElement)
  })

  it('shows the weekday of a person who chose one', async () => {
    signIn('member', { emailDigestWeeklyDay: 0 })
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    expect(await button()).toHaveAccessibleName('How often: Every Sunday morning')
  })

  it("saves a weekday, and every morning, as the person's own choice", async () => {
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    await choose('Every Friday morning')
    await waitFor(() => expect(patches()).toEqual([{ emailDigestWeeklyDay: 5 }]))
    expect(auth.setEmailDigestWeeklyDay).toHaveBeenCalledWith(5)
    expect(await button()).toHaveAccessibleName('How often: Every Friday morning')

    await choose('Every morning')
    await waitFor(() => expect(patches()).toEqual([{ emailDigestWeeklyDay: 5 }, { emailDigestWeeklyDay: null }]))
    expect(auth.setEmailDigestWeeklyDay).toHaveBeenLastCalledWith(null)
  })

  it('saves nothing when the person picks the choice they already have', async () => {
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    await choose('Every morning')
    expect(patches()).toEqual([])
  })

  it('puts the choice back when the save fails', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/users/me' && init?.method === 'PATCH') throw new Error('offline')
      if (path === '/config') return { modules: FRIDAY, mentionEmailsEnabled: true } as never
      if (path === '/views') return { views: [] } as never
      if (path === '/roles') return [] as never
      return {} as never
    })
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    await choose('Every Wednesday morning')
    await waitFor(async () => expect(await button()).toHaveAccessibleName('How often: Every morning'))
    expect(auth.setEmailDigestWeeklyDay).not.toHaveBeenCalled()
  })

  it('disables the menu when the team turned the digest off', async () => {
    mock({ ...FRIDAY, 'email-digest': { enabled: false } })
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    const yours = await section('Your notifications')
    await yours.findByText('One email that sums up what changed on your bills since the last one.')
    expect(await button()).toBeDisabled()
  })
})

describe('the team section', () => {
  beforeEach(() => signIn('admin'))

  it('has no How often or weekly day of its own', async () => {
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    const team = await section('For your whole coalition')
    await team.findByRole('radio', { name: 'Priority bills, new bills, and saved views' })
    expect(team.queryByRole('button', { name: /^How often/ })).toBeNull()
    expect(team.queryByRole('combobox', { name: 'Weekly digests go out on' })).toBeNull()
    expect(team.queryByText(/Each person chooses/)).toBeNull()
  })
})
