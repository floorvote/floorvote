import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// #643: every Profile switch's visible sentence is part of its hit target, and
// the target is at least 24px tall (WCAG 2.5.8).

const auth = vi.hoisted(() => ({ user: {} as Record<string, unknown> }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))

const BOTH_ON = { 'email-digest': { enabled: true }, 'week-ahead': { enabled: true } }

function signIn(over: Record<string, unknown> = {}) {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role: 'member', title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

function mockConfig(modules: Record<string, unknown> = BOTH_ON) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => (path === '/config' ? { modules } : {}) as never)
}

function patches() {
  return vi.mocked(api.apiFetch).mock.calls.filter(([, opts]) => (opts as { method?: string } | undefined)?.method === 'PATCH')
}

// The visible sentences: a title line and a description line per switch.
const SWITCHES = [
  { key: 'replies', name: /replies on bills you've commented on/i, titles: [/^Replies on bills you've commented on$/], extra: /Email me when someone else comments/ },
  { key: 'digest', name: /recent bill activity/i, titles: [/^Email digest of recent bill activity$/], extra: undefined },
  { key: 'matches', name: /include newly matched bills/i, titles: [/include newly matched bills/i], extra: undefined },
  { key: 'week-ahead', name: /upcoming hearings and events/i, titles: [/^Email digest of upcoming hearings and events$/], extra: undefined },
]

describe('Profile: clickable switch sentences', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    signIn()
    mockConfig()
  })

  it.each(SWITCHES)('toggles the $key switch when its visible sentence is clicked', async ({ name, titles }) => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name })
    expect(sw).toBeChecked()

    await userEvent.click(screen.getByText(titles[0]))

    await waitFor(() => expect(sw).not.toBeChecked())
    expect(patches()).toHaveLength(1)
  })

  it('toggles the replies switch from its description line too', async () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name: SWITCHES[0].name })

    await userEvent.click(screen.getByText(SWITCHES[0].extra as RegExp))

    await waitFor(() => expect(sw).not.toBeChecked())
  })

  it.each(SWITCHES)('toggles the $key switch back on with a second sentence click', async ({ name, titles }) => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name })
    await userEvent.click(screen.getByText(titles[0]))
    await waitFor(() => expect(sw).not.toBeChecked())

    await userEvent.click(screen.getByText(titles[0]))

    await waitFor(() => expect(sw).toBeChecked())
  })

  it.each(SWITCHES)('still toggles the $key switch by clicking the control itself', async ({ name }) => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name })

    await userEvent.click(sw)

    await waitFor(() => expect(sw).not.toBeChecked())
    expect(patches()).toHaveLength(1)
  })

  it.each(SWITCHES)('makes the $key switch hit target at least 24px tall', async ({ name }) => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name })
    const control = sw.parentElement as HTMLElement
    expect(parseFloat(control.style.height)).toBeGreaterThanOrEqual(24)
    expect(parseFloat(control.style.width)).toBeGreaterThanOrEqual(24)
  })

  it.each(SWITCHES)('toggles the $key switch from the keyboard', async ({ name }) => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name })

    sw.focus()
    expect(sw).toHaveFocus()
    await userEvent.keyboard(' ')

    await waitFor(() => expect(sw).not.toBeChecked())
  })

  it.each(SWITCHES)('keeps an accessible name on the $key switch', async ({ name }) => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name })
    expect(sw).toHaveAccessibleName(name)
    expect((sw.getAttribute('aria-label') ?? '') + (sw.getAttribute('aria-labelledby') ?? '')).not.toBe('')
  })

  it('names the new-match switch by its visible sentence element', async () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name: SWITCHES[2].name })
    const ref = document.getElementById(sw.getAttribute('aria-labelledby') as string)
    expect(ref).toHaveTextContent(/include newly matched bills/i)
  })

  it('does not toggle the new-match switch from its sentence while the digest is off', async () => {
    signIn({ emailDigestEnabled: false })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name: SWITCHES[2].name })
    expect(sw).toBeDisabled()
    expect(sw).toBeChecked()

    await userEvent.click(screen.getByText(SWITCHES[2].titles[0]))

    expect(sw).toBeChecked()
    expect(patches()).toHaveLength(0)
  })

  it('does not toggle a digest switch from its sentence when the admin turned it off', async () => {
    mockConfig({ 'email-digest': { enabled: false }, 'week-ahead': { enabled: false } })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const digest = await screen.findByRole<HTMLInputElement>('switch', { name: SWITCHES[1].name })
    const week = screen.getByRole<HTMLInputElement>('switch', { name: SWITCHES[3].name })
    expect(digest).toBeDisabled()
    expect(week).toBeDisabled()
    const before = [digest.checked, week.checked]

    await userEvent.click(screen.getByText(SWITCHES[1].titles[0]))
    await userEvent.click(screen.getByText(SWITCHES[3].titles[0]))

    expect([digest.checked, week.checked]).toEqual(before)
    expect(patches()).toHaveLength(0)
  })

  it('does not toggle one switch when another switch sentence is clicked', async () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const replies = await screen.findByRole('switch', { name: SWITCHES[0].name })
    const week = screen.getByRole('switch', { name: SWITCHES[3].name })

    await userEvent.click(screen.getByText(SWITCHES[1].titles[0]))

    expect(replies).toBeChecked()
    expect(week).toBeChecked()
  })
})
