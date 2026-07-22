import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

// The role-assignment chips ("Add role" trigger, per-role remove ✕) and the
// "···" actions-menu items were mouse-only (click handlers on <span>/<div>,
// unreachable by keyboard). This suite locks in that they're now real,
// keyboard-operable buttons, and that both popups (add-role dropdown,
// actions menu) expose proper role="menu"/"menuitem" semantics with
// Arrow-key navigation and Escape-to-close-and-restore-focus — without
// changing the assign/remove-role or actions behavior itself.

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

const FINANCE = { id: 'r1', name: 'Finance' }
const OPS = { id: 'r2', name: 'Ops' }
const LEGAL = { id: 'r3', name: 'Legal' }

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
  roles: [FINANCE],
  canVote: true,
  voteCount: 0,
}

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

function mockApi() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return [OWNER, MEMBER] as never
    if (path === '/admin/roles') return [FINANCE, OPS, LEGAL] as never
    if (path === '/admin/config') return {} as never
    if (path === '/admin/members/member-1/roles') return {} as never
    if (path === '/admin/members/member-1/auth-events') {
      return { events: [], suppression: { suppressed: null }, delivery: {} } as never
    }
    return {} as never
  })
}

async function renderMembers() {
  render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>,
  )
  return (await screen.findByText('Regular Member')).closest('tr')!
}

describe('Members role-assignment and actions-menu keyboard access', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the add-role trigger and the remove-role chip as real buttons', async () => {
    mockApi()
    const row = await renderMembers()

    expect(within(row).getByRole('button', { name: 'Add role' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /remove finance/i })).toBeInTheDocument()
  })

  it('opens the add-role dropdown from the keyboard and assigns a role', async () => {
    const user = userEvent.setup()
    mockApi()
    const row = await renderMembers()

    const trigger = within(row).getByRole('button', { name: 'Add role' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    trigger.focus()
    await user.keyboard('{Enter}')

    const menu = await screen.findByRole('menu', { name: /add role/i })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map(i => i.textContent)).toEqual(['Ops', 'Legal'])
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    // Focus moves into the menu as soon as it opens.
    expect(items[0]).toHaveFocus()

    await user.click(items[0])

    expect(api.apiFetch).toHaveBeenCalledWith(
      '/admin/members/member-1/roles',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ roleIds: ['r1', 'r2'] }) }),
    )
    expect(await within(row).findByText('Ops')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('navigates the add-role dropdown with ArrowDown/ArrowUp (wrapping)', async () => {
    const user = userEvent.setup()
    mockApi()
    const row = await renderMembers()

    fireEvent.click(within(row).getByRole('button', { name: 'Add role' }))
    const menu = await screen.findByRole('menu', { name: /add role/i })
    const items = within(menu).getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()

    // Wraps back to the first item.
    await user.keyboard('{ArrowDown}')
    expect(items[0]).toHaveFocus()

    // Wraps the other direction too.
    await user.keyboard('{ArrowUp}')
    expect(items[1]).toHaveFocus()
  })

  it('closes the add-role dropdown on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    mockApi()
    const row = await renderMembers()

    const trigger = within(row).getByRole('button', { name: 'Add role' })
    fireEvent.click(trigger)
    await screen.findByRole('menu', { name: /add role/i })

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('removes a role via the remove-role button', async () => {
    mockApi()
    const row = await renderMembers()

    const removeButton = within(row).getByRole('button', { name: /remove finance/i })
    fireEvent.click(removeButton)

    expect(api.apiFetch).toHaveBeenCalledWith(
      '/admin/members/member-1/roles',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ roleIds: [] }) }),
    )
    await within(row).findByRole('button', { name: 'Add role' })
    expect(within(row).queryByText('Finance')).not.toBeInTheDocument()
  })

  it('renders the "···" actions-menu items as role="menuitem" and supports Arrow/Escape', async () => {
    const user = userEvent.setup()
    mockApi()
    const row = await renderMembers()

    const actionsTrigger = within(row).getByRole('button', { name: '···' })
    expect(actionsTrigger).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(actionsTrigger)

    const menu = await screen.findByRole('menu', { name: /actions/i })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.length).toBeGreaterThan(1)
    expect(items[0]).toHaveTextContent('Login activity')
    expect(items[0]).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(actionsTrigger).toHaveFocus()
  })

  it('still performs the action when an actions-menu item is activated', async () => {
    mockApi()
    const row = await renderMembers()

    fireEvent.click(within(row).getByRole('button', { name: '···' }))
    const loginActivityItem = await screen.findByRole('menuitem', { name: 'Login activity' })
    fireEvent.click(loginActivityItem)

    expect(await screen.findByText('Regular Member · member@example.com')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
