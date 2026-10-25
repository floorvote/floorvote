import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Profile } from './Profile'
import * as api from '../lib/api'

// #776: the switch input is visually hidden (0x0), so the global
// *:focus-visible ring on it paints nothing. The ring goes on the track that
// follows it. jsdom can't evaluate :focus-visible, so pin the class and the rule.

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

const mobileCss = readFileSync(resolve(__dirname, '../styles/mobile.css'), 'utf8')

const NAMES = [/replies on bills you've commented on/i, /recent bill activity/i, /include newly matched bills/i, /upcoming hearings and events/i]

describe('Profile: switch focus ring', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    auth.user = {
      id: 'u1', email: 'a@b.c', name: 'A', role: 'member', title: null,
      canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
      lastSeenFeed: null, isLastOwner: false,
    }
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => (
      path === '/config' ? { modules: { 'email-digest': { enabled: true }, 'week-ahead': { enabled: true } } } : {}
    ) as never)
  })

  it.each(NAMES)('marks the %s input so its track takes the focus ring', async (name) => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name })
    expect(sw).toHaveClass('fv-switch-input')
    const track = sw.nextElementSibling as HTMLElement
    expect(track.tagName).toBe('SPAN')
    expect(track.style.inset).toBe('0px')
    expect(track.style.borderRadius).not.toBe('')
  })

  it('draws the ring on the track only for keyboard focus', () => {
    expect(mobileCss).toMatch(/\.fv-switch-input:focus-visible\s*\+\s*span\s*\{[^}]*outline:\s*2px solid var\(--fv-focus-ring\)/)
    expect(mobileCss).not.toMatch(/\.fv-switch-input:focus\s*\+/)
  })
})

// An inline `outline: 'none'` beats the global *:focus-visible ring, and these
// inputs draw no focus border of their own, so keyboard focus was invisible.
describe('Profile: text input focus ring', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    auth.user = {
      id: 'u1', email: 'a@b.c', name: 'A', role: 'member', title: null,
      canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
      lastSeenFeed: null, isLastOwner: false,
    }
    vi.spyOn(api, 'apiFetch').mockResolvedValue({} as never)
  })

  it('sets no inline outline on the name, title, or new-email input', async () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Change email…' }))
    for (const label of ['Name', 'Title', 'New email']) {
      const input = screen.getByLabelText(label) as HTMLInputElement
      expect(input.tagName, label).toBe('INPUT')
      expect(input.style.outline, label).toBe('')
    }
  })
})
