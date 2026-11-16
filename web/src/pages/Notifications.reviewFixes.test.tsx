import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'
import * as api from '../lib/api'
import { color } from '../styles/tokens'

// The Notifications page inside the real AuthProvider, for what a mocked useAuth can't show: a trip away from the
// page and back, and a failed read of the team's settings.

const retry = vi.hoisted(() => ({ me: {} as Record<string, unknown> }))
vi.mock('../lib/retryFetch', () => ({
  retryFetch: async () => retry.me,
  createProgressBox: () => ({ current: null }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }),
}))

import { AuthProvider } from '../context/AuthContext'
import { Notifications } from './Notifications'

const BOTH_ON = { 'email-digest': { enabled: true, settings: { frequency: 'daily' } }, 'week-ahead': { enabled: true, settings: { weeklyDay: '1' } }, 'waiting-for-vote': true, 'upcoming-hearings': true }

function me(role: string, over: Record<string, unknown> = {}) {
  retry.me = {
    id: 'u1', email: 'a@b.c', name: 'A', role, title: null, canVote: true,
    emailDigestEnabled: true, emailDigestMatchesEnabled: null, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

/** `configFailures` is how many reads of /config fail before one succeeds. */
function mockApi(opts: { configFailures?: number; conversationEmails?: boolean } = {}) {
  let failures = opts.configFailures ?? 0
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') {
      if (failures > 0) { failures -= 1; throw new Error('network blip') }
      return { modules: BOTH_ON, mentionEmailsEnabled: opts.conversationEmails ?? true } as never
    }
    if (path === '/views') return { views: [] } as never
    if (path === '/roles') return [] as never
    return {} as never
  })
}

// A button that unmounts and remounts the page, as a trip to the Account tab does.
function Harness() {
  const [shown, setShown] = useState(true)
  return (
    <AuthProvider>
      <button onClick={() => setShown(s => !s)}>toggle page</button>
      {shown && <Notifications />}
    </AuthProvider>
  )
}

const renderPage = () => render(<MemoryRouter><Harness /></MemoryRouter>)

beforeEach(() => {
  vi.restoreAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('a failed read of the team settings', () => {
  it('tells a member it could not load, with a Retry, and shows no "Turned off" notes', async () => {
    me('member', { emailDigestMatchesEnabled: true })
    mockApi({ configFailures: 1 })
    renderPage()
    expect(await screen.findByText("Couldn't load your coalition's settings.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('Turned off by your coalition.')).not.toBeInTheDocument()
  })

  it('states no "Sent …" schedule for the digest or the week ahead email while the settings are not loaded', async () => {
    me('member', { emailDigestMatchesEnabled: true })
    mockApi({ configFailures: 1 })
    renderPage()
    await screen.findByText("Couldn't load your coalition's settings.")
    expect(screen.queryByText(/Sent every/)).not.toBeInTheDocument()
    expect(screen.getByText(/^One email that sums up what changed on your bills since the last one\.$/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findAllByText(/Sent every/)).toHaveLength(1)
    expect(screen.getByText(/Sent only when something changed\.$/)).toBeInTheDocument()
  })

  it('draws the Retry as a link-style button in the link blue, with no border or background', async () => {
    me('member', { emailDigestMatchesEnabled: true })
    mockApi({ configFailures: 1 })
    renderPage()
    const retryButton = await screen.findByRole('button', { name: 'Retry' })
    expect(retryButton.style.color).toBe(color.linkBlue)
    expect(retryButton.style.background).toBe('none')
    expect(retryButton.style.borderStyle).toBe('none')
  })

  it('shows an admin no team controls, sends no save, and loads them after Retry', async () => {
    me('admin')
    const spy = mockApi({ configFailures: 1 })
    renderPage()
    expect(await screen.findByText("Couldn't load your coalition's settings.")).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Priority bills, new bills, and saved views' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Send the week ahead email' })).not.toBeInTheDocument()
    expect(screen.queryByText('Turned off by your coalition.')).not.toBeInTheDocument()
    expect(spy.mock.calls.some(c => c[0] === '/admin/config' && (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('radio', { name: 'Priority bills, new bills, and saved views' })).toBeChecked()
    expect(screen.queryByText("Couldn't load your coalition's settings.")).not.toBeInTheDocument()
  })
})

describe('comment emails turned off by the team', () => {
  it('tells a member they will see a mention in FloorVote, not that they always get an email', async () => {
    me('member', { emailDigestMatchesEnabled: true })
    mockApi({ conversationEmails: false })
    renderPage()
    const comments = (await screen.findByRole('heading', { level: 3, name: 'Comments' })).parentElement as HTMLElement
    await within(comments).findByText('Comment emails are turned off by your coalition.')
    expect(within(comments).getByText("You'll see it in FloorVote.")).toBeInTheDocument()
    expect(within(comments).queryByText(/You'll always get an email/)).not.toBeInTheDocument()
  })
})

describe('coming back to the page', () => {
  it('keeps the week ahead switch where the person left it', async () => {
    me('member', { emailDigestMatchesEnabled: true })
    mockApi()
    renderPage()
    const weekAhead = await screen.findByRole('switch', { name: 'Get the week ahead email' })
    const priority = screen.getByRole('switch', { name: 'Changes to priority bills' })
    await act(async () => { fireEvent.click(weekAhead) })
    await act(async () => { fireEvent.click(priority) })
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Get the week ahead email' })).not.toBeChecked())
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Changes to priority bills' })).not.toBeChecked())
    await act(async () => { fireEvent.click(screen.getByText('toggle page')) })
    await act(async () => { fireEvent.click(screen.getByText('toggle page')) })
    expect(await screen.findByRole('switch', { name: 'Get the week ahead email' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Changes to priority bills' })).not.toBeChecked()
  })
})

describe('switches named by a label', () => {
  it('are still described by their description and any turned-off note', async () => {
    me('member', { emailDigestMatchesEnabled: true })
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/config') return { modules: { 'email-digest': { enabled: true }, 'week-ahead': { enabled: false } }, mentionEmailsEnabled: false } as never
      if (path === '/views') return { views: [] } as never
      return {} as never
    })
    renderPage()
    const weekAhead = await screen.findByRole('switch', { name: 'Get the week ahead email' })
    await waitFor(() => expect(weekAhead).toHaveAccessibleDescription(expect.stringContaining('Turned off by your coalition.')))
    expect(weekAhead).toHaveAccessibleDescription(expect.stringContaining("Next week's hearings"))
    expect(screen.getByRole('switch', { name: 'Someone replies on a bill you commented on' })).toHaveAccessibleDescription(expect.stringContaining('You get these in FloorVote.'))
  })
})
