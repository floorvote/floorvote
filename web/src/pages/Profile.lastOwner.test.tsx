import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'

// Mutable mock user so each test can vary `isLastOwner` while reusing a single
// vi.mock factory — vi.mock factories are hoisted above imports, so the
// mutable state must come from vi.hoisted (same pattern as Profile.demote.test.tsx).
const { mockUser } = vi.hoisted(() => ({
  mockUser: {
    id: 'u1', email: 'a@b.c', name: 'A', role: 'owner' as 'member' | 'admin' | 'owner', subtitle: null,
    canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null,
    isLastOwner: false,
  },
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false, authError: false,
    setSubtitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

const LAST_OWNER_BLOCK = "You're the only owner. Make another member an owner before you can demote, deactivate, or delete your account."

function renderProfile() {
  const value = { config: { orgNoun: 'coalition', accountDeletionEnabled: true } as AppConfig, multiState: false, loading: false }
  return render(
    <ConfigContext.Provider value={value}>
      <MemoryRouter><Profile /></MemoryRouter>
    </ConfigContext.Provider>,
  )
}

describe('Profile last-owner gating', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/config') return {} as never
      return {} as never
    })
    mockUser.role = 'owner'
  })

  it('disables Demote, Deactivate, and Delete and shows the blocking line on all three rows when the owner is the last one', async () => {
    mockUser.isLastOwner = true
    renderProfile()

    const demote = await screen.findByRole('button', { name: 'Demote my account from Owner to Admin' })
    const deactivate = screen.getByRole('button', { name: 'Deactivate my account' })
    const del = screen.getByRole('button', { name: 'Delete my account' })

    expect(demote).toBeDisabled()
    expect(deactivate).toBeDisabled()
    expect(del).toBeDisabled()

    const blockingTexts = screen.getAllByText(LAST_OWNER_BLOCK)
    expect(blockingTexts).toHaveLength(3)

    // Normal descriptions are replaced, not merely supplemented.
    expect(screen.queryByText(/An admin can reactivate your account/)).not.toBeInTheDocument()
    expect(screen.queryByText(/This cannot be undone\./)).not.toBeInTheDocument()
  })

  it('leaves Demote, Deactivate, and Delete enabled with normal descriptions when not the last owner', async () => {
    mockUser.isLastOwner = false
    renderProfile()

    const demote = await screen.findByRole('button', { name: 'Demote my account from Owner to Admin' })
    const deactivate = screen.getByRole('button', { name: 'Deactivate my account' })
    const del = screen.getByRole('button', { name: 'Delete my account' })

    expect(demote).not.toBeDisabled()
    expect(deactivate).not.toBeDisabled()
    expect(del).not.toBeDisabled()

    expect(screen.queryByText(LAST_OWNER_BLOCK)).not.toBeInTheDocument()
    expect(screen.getByText(/An admin can reactivate your account/)).toBeInTheDocument()
    expect(screen.getByText(/This cannot be undone\./)).toBeInTheDocument()
  })
})
