import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'
import { buttonTextContrast } from '../../test/colorTokens'

// Send invites is a primary (solid blue) button. Whatever state it is in, no
// opacity may sit over its colors: that would drop the label below the AA bar
// (enabled) or the 3:1 bar (disabled) the fill and text were chosen to clear.

const OWNER = {
  id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' as const, title: null,
  createdAt: '2024-01-01T00:00:00Z', lastActive: '2024-01-01T00:00:00Z', deactivatedAt: null, roles: [],
  canVote: true, voteCount: 0, loginTrouble: false, emailBounce: null, hasLoggedIn: true, invitedBy: null,
}

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

function mockApi({ holdInvite = false }: { holdInvite?: boolean } = {}) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return [OWNER] as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/members/bulk-invite') {
      if (holdInvite) await new Promise(() => {})
      return { summary: { invited: 1, exists: 0, duplicate: 0, invalid: 0 }, results: [] } as never
    }
    return {} as never
  })
}

async function renderMembers() {
  render(<MemoryRouter><Members /></MemoryRouter>)
  await screen.findByText('Sole Owner')
}

afterEach(() => { vi.restoreAllMocks(); demoState.demoLocked = false })

describe('Members Send invites button colors', () => {
  it('enabled: the blue fill, no opacity, text clears AA in both modes', async () => {
    mockApi()
    await renderMembers()
    const btn = screen.getByRole('button', { name: 'Send invites' })
    expect(btn).toBeEnabled()
    expect(btn.style.opacity).toBe('')
    expect(buttonTextContrast(btn, 'light')).toBeGreaterThanOrEqual(4.5)
    expect(buttonTextContrast(btn, 'dark')).toBeGreaterThanOrEqual(4.5)
  })

  it('demo-locked: the disabled colors, no opacity, text at 3:1 or better in both modes', async () => {
    demoState.demoLocked = true
    mockApi()
    await renderMembers()
    const btn = screen.getByRole('button', { name: 'Send invites' })
    expect(btn).toBeDisabled()
    expect(btn.style.opacity).toBe('')
    expect(btn.style.background).toBe('var(--fv-surface-muted)')
    expect(buttonTextContrast(btn, 'light')).toBeGreaterThanOrEqual(3)
    expect(buttonTextContrast(btn, 'dark')).toBeGreaterThanOrEqual(3)
  })

  it('sending: the disabled colors, no opacity, text at 3:1 or better in both modes', async () => {
    mockApi({ holdInvite: true })
    await renderMembers()
    await userEvent.type(screen.getByLabelText('Invitees'), 'new@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send invites' }))
    const btn = await screen.findByRole('button', { name: 'Sending…' })
    expect(btn).toBeDisabled()
    expect(btn.style.opacity).toBe('')
    expect(btn.style.background).toBe('var(--fv-surface-muted)')
    expect(buttonTextContrast(btn, 'light')).toBeGreaterThanOrEqual(3)
    expect(buttonTextContrast(btn, 'dark')).toBeGreaterThanOrEqual(3)
  })
})
