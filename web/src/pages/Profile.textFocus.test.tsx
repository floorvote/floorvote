import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'


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
