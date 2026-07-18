import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import { color } from '../../styles/tokens'

const OWNER = { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' }
const NON_OWNER_ADMIN = { id: 'admin-1', email: 'admin@example.com', name: 'An Admin', role: 'admin' }

const MEMBERS = [
  {
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
  },
  {
    id: 'admin-1',
    email: 'admin@example.com',
    name: 'An Admin',
    role: 'admin' as const,
    subtitle: null,
    createdAt: '2024-01-01T00:00:00Z',
    lastActive: '2024-01-01T00:00:00Z',
    deactivatedAt: null,
    hasLoggedIn: true,
    invitedBy: null,
    roles: [],
    canVote: true,
    voteCount: 0,
  },
]

vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}))

function mockApi(accountDeletionEnabled: boolean) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return MEMBERS as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return { accountDeletionEnabled } as never
    return {} as never
  })
}

async function openAdminMenu() {
  const adminRow = (await screen.findByText('An Admin')).closest('tr')!
  fireEvent.click(within(adminRow).getByRole('button', { name: '···' }))
}

describe('Members owner-only deletion-policy switch', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the switch for an Owner and hides "Permanently delete" when the flag is off', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: OWNER, loading: false } as never)
    mockApi(false)

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const sw = await screen.findByRole('switch', { name: /account deletion/i })
    expect(sw).toBeInTheDocument()
    expect(sw).toBeEnabled()

    await openAdminMenu()
    expect(screen.queryByText('Permanently delete')).not.toBeInTheDocument()
  })

  it('shows "Permanently delete" when the flag is on', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: OWNER, loading: false } as never)
    mockApi(true)

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('switch', { name: /account deletion/i })).toBeInTheDocument()

    await openAdminMenu()
    expect(await screen.findByText('Permanently delete')).toBeInTheDocument()
  })

  it('shows the switch to a non-owner Admin but disabled, with the owner-only note', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: NON_OWNER_ADMIN, loading: false } as never)
    mockApi(true)

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const sw = await screen.findByRole('switch', { name: /account deletion/i })
    expect(sw).toBeInTheDocument()
    expect(sw).toBeDisabled()
    expect(screen.getByText('Only owners can adjust this setting.')).toBeInTheDocument()
  })

  it('renders the toggle inside the All-members card, after the table, with a red label', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: OWNER, loading: false } as never)
    mockApi(true)

    const { container } = render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const toggleLabel = await screen.findByText('Allow owners and admins to irreversibly delete member accounts.')
    const tableWrap = container.querySelector('.members-table-wrap')
    expect(tableWrap).not.toBeNull()

    // Same card: the "All members" card is the table wrap's parent, and the
    // moved toggle block must live inside that same card, not a sibling card.
    const card = tableWrap!.parentElement!
    expect(card.contains(toggleLabel)).toBe(true)

    // DOM order: the table wrap must precede the toggle block within the card.
    const position = tableWrap!.compareDocumentPosition(toggleLabel)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Label color: reddened per Option B, not the neutral textPrimary it used to be.
    expect(toggleLabel).toHaveStyle({ color: color.textErrorRed })
  })
})
