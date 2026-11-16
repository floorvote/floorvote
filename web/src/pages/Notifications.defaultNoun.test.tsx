import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
import * as api from '../lib/api'

// With the default org noun, "team", the page reads as it did before the noun was threaded through its copy.

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'admin', title: null, canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: null, emailWeekAheadEnabled: true, emailRepliesEnabled: true, lastSeenFeed: null, isLastOwner: false },
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'team' }, multiState: false, loading: false }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }),
}))

beforeEach(() => {
  vi.restoreAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') return { modules: { 'email-digest': { enabled: true }, 'week-ahead': { enabled: true } }, mentionEmailsEnabled: true } as never
    if (path === '/views') return { views: [] } as never
    return [] as never
  })
})

describe('the Notifications page with the default org noun', () => {
  it('says "team" in the heading and the descriptions', async () => {
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    await screen.findByRole('heading', { level: 2, name: 'For your whole team' })
    const you = screen.getByRole('heading', { level: 2, name: 'Your notifications' }).parentElement as HTMLElement
    expect(within(you).getByText('Status changes, hearings, positions, and comments on bills your team marked as a priority.')).toBeInTheDocument()
    expect(within(you).getByRole('switch', { name: 'New bills that may be relevant to your team' })).toBeInTheDocument()
    expect(within(you).getByText("Next week's hearings on your team's priority bills and events on your team calendar. Sent every Monday morning.")).toBeInTheDocument()
  })
})
