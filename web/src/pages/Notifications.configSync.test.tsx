import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
import { ConfigProvider, useConfig } from '../context/ConfigContext'
import { isModuleEnabled } from '../lib/modules'
import * as api from '../lib/api'

// After an admin saves the digest on the Notifications tab, module-gated UI elsewhere (the Bills page envelope)
// follows at once: the app's config is updated, with no reload.

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'a@b.c', name: 'A', role: 'admin', title: null,
      canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
      lastSeenFeed: null, isLastOwner: false,
    },
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

const START = { 'email-digest': { enabled: true, settings: { frequency: 'daily', weeklyDay: '1' } }, 'week-ahead': { enabled: true, settings: { weeklyDay: '1' } } }

function Envelope() {
  const { config } = useConfig()
  return <div>envelope:{String(isModuleEnabled(config?.modules, 'email-digest'))}</div>
}

beforeEach(() => {
  vi.restoreAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') return { states: ['RI'], orgNoun: 'coalition', modules: START, mentionEmailsEnabled: true } as never
    if (path === '/views') return { views: [] } as never
    if (path === '/roles') return [] as never
    return {} as never
  })
})

describe('Notifications: saving the digest updates the app config', () => {
  it.each([['Off', 'false'], ['Priority bills, new bills, and saved views', 'true']])('choosing %s changes module-gated UI at once', async (choice, expected) => {
    render(<MemoryRouter><ConfigProvider><Envelope /><Notifications /></ConfigProvider></MemoryRouter>)
    const heading = await screen.findByRole('heading', { level: 2, name: 'For your whole coalition' })
    const team = within(heading.parentElement as HTMLElement)
    await screen.findByText('envelope:true')
    if (choice === 'Priority bills, new bills, and saved views') {
      await userEvent.click(await team.findByRole('radio', { name: 'Off' }))
      await screen.findByText('envelope:false')
    }
    await userEvent.click(await team.findByRole('radio', { name: choice }))
    await waitFor(() => expect(screen.getByText(`envelope:${expected}`)).toBeInTheDocument())
  })
})
