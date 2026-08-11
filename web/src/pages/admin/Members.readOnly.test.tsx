import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

// Task 8: admin write controls must be disabled — never hidden — when the
// demo is locked, and re-enabled the moment it isn't. Scaffolding reused from
// Members.roleRename.test.tsx.

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

const MEMBER = {
  id: 'member-1',
  email: 'member@example.com',
  name: 'Regular Member',
  role: 'member' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: 'owner-1',
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
    if (path === '/admin/members') return [OWNER, MEMBER] as never
    if (path === '/admin/roles') return [ROLE] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
}

function renderMembers({ demoLocked }: { demoLocked: boolean }) {
  demoState.demoLocked = demoLocked
  mockApi()
  return render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>,
  )
}

afterEach(() => { vi.restoreAllMocks(); demoState.demoLocked = false })

describe('Members admin write controls when demoLocked', () => {
  it('disables invite and role editing when demoLocked', async () => {
    renderMembers({ demoLocked: true })
    expect(await screen.findByRole('button', { name: /invite/i })).toBeDisabled()
  })

  it('disables the "Add role" button even with a non-empty role name', async () => {
    renderMembers({ demoLocked: true })
    const user = userEvent.setup()
    await user.type(await screen.findByPlaceholderText(/new role name/i), 'Legal')
    expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled()
  })

  it('disables the rename-role and delete-role affordances on an existing role', async () => {
    renderMembers({ demoLocked: true })
    expect(await screen.findByRole('button', { name: /rename role finance committee/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /delete role finance committee/i })).toBeDisabled()
  })

  it('disables the "Can vote" checkbox on every member row', async () => {
    renderMembers({ demoLocked: true })
    const checkboxes = await screen.findAllByTitle('Locked in demo mode')
    expect(checkboxes.length).toBeGreaterThan(0)
    for (const checkbox of checkboxes) expect(checkbox).toBeDisabled()
  })
})

describe('Members admin write controls when not demoLocked', () => {
  it('leaves invite and role editing enabled', async () => {
    renderMembers({ demoLocked: false })
    expect(await screen.findByRole('button', { name: /invite/i })).toBeEnabled()
  })

  it('leaves the "Add role" button enabled once a role name is entered', async () => {
    renderMembers({ demoLocked: false })
    const user = userEvent.setup()
    await user.type(await screen.findByPlaceholderText(/new role name/i), 'Legal')
    expect(screen.getByRole('button', { name: /^add$/i })).toBeEnabled()
  })

  it('leaves the rename-role and delete-role affordances enabled', async () => {
    renderMembers({ demoLocked: false })
    expect(await screen.findByRole('button', { name: /rename role finance committee/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /delete role finance committee/i })).toBeEnabled()
  })
})
