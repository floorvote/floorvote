import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'
import * as api from '../lib/api'

// The Notifications page inside the real AuthProvider, for what a mocked useAuth can't show: a trip away from the
// page and back.

const retry = vi.hoisted(() => ({ me: {} as Record<string, unknown> }))
vi.mock('../lib/retryFetch', () => ({
  retryFetch: async () => retry.me,
  createProgressBox: () => ({ current: null }),
}))
const cfg = vi.hoisted(() => ({ emailsOn: true }))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition', notificationEmailsEnabled: cfg.emailsOn, weekAheadDay: 5 }, multiState: false, loading: false }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }),
}))

import { AuthProvider } from '../context/AuthContext'
import { Notifications } from './Notifications'

function me(role: string, over: Record<string, unknown> = {}) {
  retry.me = {
    id: 'u1', email: 'a@b.c', name: 'A', role, title: null, canVote: true,
    emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

function mockApi() {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
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
  cfg.emailsOn = true
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
  it('are still described by their description, in the app-only wording when email to members is off', async () => {
    cfg.emailsOn = false
    me('member')
    mockApi()
    renderPage()
    const weekAhead = await screen.findByRole('switch', { name: 'Get the week ahead email' })
    expect(weekAhead).toHaveAccessibleDescription(expect.stringContaining("Next week's hearings"))
    expect(screen.getByRole('switch', { name: 'Someone replies on a bill you commented on' })).toHaveAccessibleDescription(expect.stringContaining('You get these in FloorVote.'))
  })
})
