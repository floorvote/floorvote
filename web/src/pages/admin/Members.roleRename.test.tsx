import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

const OWNER = {
  id: 'owner-1',
  email: 'owner@example.com',
  name: 'Sole Owner',
  role: 'owner' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: null,
  roles: [],
  canVote: true,
  voteCount: 0,
}

const ROLE = { id: 'r1', name: 'Finance Committee' }

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

// DemoContext's default value (no provider wrapping) is demoLocked: false; a
// mutable flag lets individual tests opt into the demo-locked state without a
// module-level mock rewrite per test.
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

function mockApi() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return [OWNER] as never
    if (path === '/admin/roles') return [ROLE] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
}

afterEach(() => { vi.restoreAllMocks(); demoState.demoLocked = false })

// The role-rename "click to rename" affordance was a plain span with an
// onClick handler — unreachable by keyboard. It must be a real button.
describe('Members role-rename inline edit keyboard access', () => {
  it('renders the role-rename affordance as a button and enters rename mode from the keyboard', async () => {
    const user = userEvent.setup()
    mockApi()

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const rename = await screen.findByRole('button', { name: /rename role finance committee/i })
    rename.focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByDisplayValue('Finance Committee')).toBeInTheDocument()
  })

  it('disables the role-rename button in demo-locked mode', async () => {
    demoState.demoLocked = true
    mockApi()

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const rename = await screen.findByRole('button', { name: /rename role finance committee/i })
    expect(rename).toBeDisabled()
  })
})
