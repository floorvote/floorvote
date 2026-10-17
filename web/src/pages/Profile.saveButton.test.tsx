import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'
import { expectPrimaryButtonLegible } from '../test/colorTokens'

// Profile's Save is a primary (solid blue) button. Enabled it clears AA; disabled
// (a save in flight, or demo lock) it wears the muted-surface fill, and no opacity
// sits over either, which would pull the label below its bar.

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'a@b.c', name: 'Current Name', role: 'member', title: null,
      canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null,
      isLastOwner: false,
    },
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

function mockApi({ holdSave = false }: { holdSave?: boolean } = {}) {
  let release: () => void = () => {}
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/users/me' && init?.method === 'PATCH') {
      if (holdSave) await new Promise<void>(resolve => { release = resolve })
      return {} as never
    }
    return {} as never
  })
  return { release: () => release() }
}

function setup() {
  const user = userEvent.setup()
  render(<MemoryRouter><Profile /></MemoryRouter>)
  const card = screen.getByRole('heading', { level: 1, name: 'Profile' }).parentElement as HTMLElement
  return { user, card }
}
const saveButton = (card: HTMLElement) => within(card).getByRole('button', { name: /^(save|saving…)$/i })

beforeEach(() => vi.restoreAllMocks())
afterEach(() => { demoState.demoLocked = false })

describe('Profile Save button colors', () => {
  it('enabled: the blue fill, no opacity, text clears AA in both modes', () => {
    mockApi()
    const { card } = setup()
    expect(saveButton(card)).toBeEnabled()
    expectPrimaryButtonLegible(saveButton(card), { disabled: false })
  })

  it('demo-locked: the disabled colors, no opacity, text at 3:1 or better in both modes', () => {
    demoState.demoLocked = true
    mockApi()
    const { card } = setup()
    expect(saveButton(card)).toBeDisabled()
    expectPrimaryButtonLegible(saveButton(card), { disabled: true })
  })

  it('saving: the disabled colors, no opacity, text at 3:1 or better in both modes, then back to enabled', async () => {
    const { release } = mockApi({ holdSave: true })
    const { user, card } = setup()
    await user.click(saveButton(card))
    expect(saveButton(card)).toBeDisabled()
    expectPrimaryButtonLegible(saveButton(card), { disabled: true })
    await act(async () => { release() })
    await waitFor(() => expect(saveButton(card)).toBeEnabled())
    expectPrimaryButtonLegible(saveButton(card), { disabled: false })
  })
})
