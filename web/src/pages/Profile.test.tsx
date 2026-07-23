import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'a@b.c', name: 'A', role: 'member', subtitle: null,
      canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null,
      isLastOwner: false,
    },
    loading: false, authError: false,
    setSubtitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
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

  it('exposes the Preferences and Account section titles as level-2 headings', () => {
    mockConfig({})
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getByRole('heading', { level: 2, name: 'Preferences' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Account' })).toBeInTheDocument()
  })
})
